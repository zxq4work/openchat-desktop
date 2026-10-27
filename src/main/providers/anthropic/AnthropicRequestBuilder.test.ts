import { describe, it, expect } from 'vitest'
import { buildAnthropicRequestBody, AnthropicRequestError, type AnthropicImageEncoder } from './AnthropicRequestBuilder'
import type { CanonicalModelRequest } from '../../../shared/types/provider'

const noImage: AnthropicImageEncoder = { encode: () => null }

function req(overrides: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest {
  return {
    model: 'claude-test',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

describe('buildAnthropicRequestBody', () => {
  it('single-turn text: minimal fields only', () => {
    const body = buildAnthropicRequestBody(req(), noImage)
    expect(body.model).toBe('claude-test')
    expect(body.max_tokens).toBe(4096)
    expect(body.stream).toBe(true)
    expect(body.system).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(body.thinking).toBeUndefined()
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('multi-turn preserves order', () => {
    const body = buildAnthropicRequestBody(req({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    }), noImage)
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(body.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual(['a', 'b', 'c'])
  })

  it('system prompt is sent at top level, empty system omitted', () => {
    expect(buildAnthropicRequestBody(req({ systemPrompt: 'be nice' }), noImage).system).toBe('be nice')
    expect(buildAnthropicRequestBody(req({ systemPrompt: '   ' }), noImage).system).toBeUndefined()
  })

  it('system/developer canonical messages never leak into messages array', () => {
    const body = buildAnthropicRequestBody(req({
      systemPrompt: 'sys',
      messages: [
        { role: 'system', content: 'should not appear' },
        { role: 'developer', content: 'should not appear' },
        { role: 'user', content: 'hi' },
      ],
    }), noImage)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
  })

  it('custom model id is used verbatim (no claude- prefix enforced)', () => {
    expect(buildAnthropicRequestBody(req({ model: 'my-custom-model' }), noImage).model).toBe('my-custom-model')
  })

  it('does not send tools when none configured', () => {
    expect(buildAnthropicRequestBody(req(), noImage).tools).toBeUndefined()
  })

  it('maps tool definitions to input_schema (not function.parameters)', () => {
    const body = buildAnthropicRequestBody(req({
      tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      toolChoice: 'auto',
    }), noImage)
    expect(body.tools).toEqual([{
      name: 'get_weather',
      description: 'weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }])
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('does not send thinking by default', () => {
    expect(buildAnthropicRequestBody(req(), noImage).thinking).toBeUndefined()
  })

  it('budget thinking validates against max_tokens', () => {
    expect(() => buildAnthropicRequestBody(req({
      anthropic: { thinking: { mode: 'budget', budgetTokens: 5000 }, maxOutputTokens: 4096 },
    }), noImage)).toThrow(AnthropicRequestError)

    const body = buildAnthropicRequestBody(req({
      anthropic: { thinking: { mode: 'budget', budgetTokens: 2048 }, maxOutputTokens: 4096 },
    }), noImage)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  })

  it('adaptive thinking sends type adaptive', () => {
    const body = buildAnthropicRequestBody(req({ anthropic: { thinking: { mode: 'adaptive' } } }), noImage)
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('forced tool choice downgrades to auto when thinking enabled', () => {
    const body = buildAnthropicRequestBody(req({
      tools: [{ name: 't', description: '', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'required',
      anthropic: { thinking: { mode: 'adaptive' } },
    }), noImage)
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('2026-10-21 strips temperature / top_p / top_k including dynamic params', () => {
    const body = buildAnthropicRequestBody(req({
      temperature: 0.7,
      anthropic: { apiVersion: '2026-10-21' },
      dynamicParameters: [
        { id: 'top_p', path: 'top_p', value: 0.9 },
        { id: 'top_k', path: 'top_k', value: 40 },
      ],
    }), noImage)
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.top_k).toBeUndefined()
  })

  it('2023-06-01 keeps configured temperature', () => {
    const body = buildAnthropicRequestBody(req({
      temperature: 0.7,
      anthropic: { apiVersion: '2023-06-01' },
    }), noImage)
    expect(body.temperature).toBe(0.7)
  })

  it('tool_result messages are grouped into one user message', () => {
    const body = buildAnthropicRequestBody(req({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }, { id: 'b', name: 'y', arguments: '{}' }] },
        { role: 'tool', content: 'ra', toolResult: { callId: 'a', name: 'x', output: 'ra' } },
        { role: 'tool', content: 'rb', toolResult: { callId: 'b', name: 'y', output: 'rb' } },
      ],
    }), noImage)
    const last = body.messages[body.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toHaveLength(2)
    expect(last.content.every((b) => b.type === 'tool_result')).toBe(true)
  })

  it('image input encodes base64 and rejects unsupported mime', () => {
    const encoder: AnthropicImageEncoder = {
      encode: (id) => id === 'ok' ? { mediaType: 'image/png', data: 'AAAA' } : { mediaType: 'image/bmp', data: 'BBBB' },
    }
    const body = buildAnthropicRequestBody(req({
      messages: [{ role: 'user', content: 'look', inputParts: [{ type: 'text', text: 'look' }, { type: 'image', attachmentId: 'ok' }] }],
    }), encoder)
    const img = body.messages[0].content.find((b) => b.type === 'image') as { source: { type: string; media_type: string; data: string } }
    expect(img.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' })

    expect(() => buildAnthropicRequestBody(req({
      messages: [{ role: 'user', content: 'x', inputParts: [{ type: 'image', attachmentId: 'bad' }] }],
    }), encoder)).toThrow()
  })

  it('replays native blocks only for same protocol + same model', () => {
    const nativeBlocks = [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'text', text: 'answer' }]
    const sameModel = buildAnthropicRequestBody(req({
      messages: [{ role: 'assistant', content: 'answer', nativeBlocks, nativeBlocksProtocol: 'anthropic_messages', nativeBlocksModelId: 'claude-test' }],
    }), noImage)
    expect(sameModel.messages[0].content).toEqual(nativeBlocks)

    const diffModel = buildAnthropicRequestBody(req({
      messages: [{ role: 'assistant', content: 'answer', nativeBlocks, nativeBlocksProtocol: 'anthropic_messages', nativeBlocksModelId: 'other-model' }],
    }), noImage)
    // Falls back to plain text serialization, not the native thinking block
    expect(diffModel.messages[0].content).toEqual([{ type: 'text', text: 'answer' }])
  })

  it('prompt caching adds at most ephemeral breakpoints when enabled', () => {
    const body = buildAnthropicRequestBody(req({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      anthropic: { promptCaching: true },
    }), noImage)
    expect(Array.isArray(body.system)).toBe(true)
    const sys = body.system as Array<{ cache_control?: { type: string } }>
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' })
    const lastBlock = body.messages[0].content[body.messages[0].content.length - 1] as { cache_control?: { type: string } }
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('prompt caching is off by default (no cache_control)', () => {
    const body = buildAnthropicRequestBody(req({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] }), noImage)
    expect(body.system).toBe('sys')
    const lastBlock = body.messages[0].content[0] as { cache_control?: unknown }
    expect(lastBlock.cache_control).toBeUndefined()
  })

  it('never forwards OpenAI-specific fields', () => {
    const body = buildAnthropicRequestBody(req({ maxOutputTokens: 100 }), noImage)
    const keys = Object.keys(body)
    expect(keys).not.toContain('max_completion_tokens')
    expect(keys).not.toContain('response_format')
    expect(keys).not.toContain('reasoning_effort')
    expect(keys).not.toContain('tool_calls')
  })

  it('multi-turn transcript is replayed verbatim when present', () => {
    const transcript = [
      { role: 'assistant' as const, blocks: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'tool_use', id: 'tu', name: 'n', input: {} }] },
      { role: 'user' as const, blocks: [{ type: 'tool_result', tool_use_id: 'tu', content: 'r' }] },
      { role: 'assistant' as const, blocks: [{ type: 'text', text: 'done' }] },
    ]
    const body = buildAnthropicRequestBody(req({
      messages: [{ role: 'assistant', content: 'done', nativeBlocksProtocol: 'anthropic_messages', nativeBlocksModelId: 'claude-test', nativeTranscript: transcript }],
    }), noImage)
    expect(body.messages).toHaveLength(3)
    expect(body.messages[0].content[0]).toEqual({ type: 'thinking', thinking: 't', signature: 'sig' })
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu', content: 'r' })
    expect(body.messages[2].content[0]).toEqual({ type: 'text', text: 'done' })
  })
})

describe('buildAnthropicRequestBody — reasoning effort (output_config.effort)', () => {
  // effort 直接来自会话，无需额外开关：与其它协议一样，选中即发送。
  const withEffort = (reasoningEffort: string, extra: Partial<CanonicalModelRequest['anthropic']> = {}) =>
    buildAnthropicRequestBody(req({ reasoningEffort, anthropic: extra }), noImage)

  it('missing effort → no output_config', () => {
    const body = buildAnthropicRequestBody(req(), noImage)
    expect(body.output_config).toBeUndefined()
  })

  it('none / invalid → no output_config (never sent verbatim)', () => {
    expect(withEffort('none').output_config).toBeUndefined()
    expect(withEffort('ultra').output_config).toBeUndefined()
  })

  it('minimal → output_config.effort "low" (client compat mapping)', () => {
    const body = withEffort('minimal')
    expect(body.output_config).toEqual({ effort: 'low' })
    // 绝不发送非法的 "minimal" 值
    expect((body.output_config as { effort: string }).effort).not.toBe('minimal')
  })

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('%s → output_config.effort', (effort) => {
    const body = withEffort(effort)
    expect(body.output_config).toEqual({ effort })
    // 绝不发送 OpenAI 的 reasoning_effort 给 Anthropic
    expect((body as Record<string, unknown>).reasoning_effort).toBeUndefined()
  })

  it('adaptive thinking + medium effort sends both independently', () => {
    const body = withEffort('medium', { thinking: { mode: 'adaptive' }, maxOutputTokens: 4096 })
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'medium' })
  })

  it('thinking off does not suppress effort', () => {
    const body = withEffort('medium', { thinking: { mode: 'off' } })
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toEqual({ effort: 'medium' })
  })

  it('manual budget thinking still uses budget_tokens (never maps effort into budget)', () => {
    const body = withEffort('high', { thinking: { mode: 'budget', budgetTokens: 2048 }, maxOutputTokens: 4096 })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('2026-10-21 keeps effort while stripping sampling params', () => {
    const body = buildAnthropicRequestBody(req({
      reasoningEffort: 'high',
      temperature: 0.7,
      anthropic: { apiVersion: '2026-10-21' },
    }), noImage)
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.temperature).toBeUndefined()
  })

  it('2023-06-01 does not drop supported effort', () => {
    const body = withEffort('low', { apiVersion: '2023-06-01' })
    expect(body.output_config).toEqual({ effort: 'low' })
  })
})