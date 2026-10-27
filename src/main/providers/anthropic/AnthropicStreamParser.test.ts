import { describe, it, expect } from 'vitest'
import { AnthropicStreamParser } from './AnthropicStreamParser'
import type { CanonicalModelEvent } from '../../../shared/types/provider'

function sse(event: string, data: Record<string, unknown>) {
  return { event, data: JSON.stringify(data) }
}

function run(events: Array<{ event: string; data: string }>): CanonicalModelEvent[] {
  const p = new AnthropicStreamParser()
  const out: CanonicalModelEvent[] = []
  for (const e of events) out.push(...p.handle(e))
  return out
}

function joinText(events: CanonicalModelEvent[]): string {
  return events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
}

describe('AnthropicStreamParser', () => {
  it('parses a basic text stream', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'test-model', usage: { input_tokens: 12, output_tokens: 1 } } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse('ping', { type: 'ping' }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，OpenChat！' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    expect(joinText(events)).toBe('你好，OpenChat！')
    const usages = events.filter((e) => e.type === 'usage') as Array<{ usage: { inputTokens?: number; outputTokens?: number } }>
    expect(usages[usages.length - 1].usage.outputTokens).toBe(15)
    expect(usages[0].usage.inputTokens).toBe(12)
    expect(events.some((e) => e.type === 'stop_reason' && e.reason === 'end_turn')).toBe(true)
    expect(events.some((e) => e.type === 'turn_completed' || e.type === 'delta')).toBe(true)
  })

  it('thinking + signature are separated from text and preserved as native blocks', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    // Visible text excludes thinking
    expect(joinText(events)).toBe('Final answer')
    // Thinking surfaced as reasoning_delta
    const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { text: string }).text).join('')
    expect(reasoning).toBe('Let me think')
    // Native thinking block retains signature
    const blocks = events.filter((e) => e.type === 'native_block').map((e) => (e as { block: Record<string, unknown> }).block)
    const thinkingBlock = blocks.find((b) => b.type === 'thinking')!
    expect(thinkingBlock.signature).toBe('sig-abc')
    expect(thinkingBlock.thinking).toBe('Let me think')
    expect(events.some((e) => e.type === 'reasoning_started')).toBe(true)
    expect(events.some((e) => e.type === 'reasoning_completed')).toBe(true)
  })

  it('redacted_thinking keeps opaque data and never becomes text', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    expect(joinText(events)).toBe('')
    const blocks = events.filter((e) => e.type === 'native_block').map((e) => (e as { block: Record<string, unknown> }).block)
    expect(blocks.find((b) => b.type === 'redacted_thinking')?.data).toBe('opaque')
  })

  it('accumulates input_json_delta and emits a tool_call with parsed input', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"重庆"}' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    const calls = events.filter((e) => e.type === 'tool_call') as Array<{ callId: string; name: string; arguments: string }>
    expect(calls).toHaveLength(1)
    expect(calls[0].callId).toBe('toolu_1')
    expect(calls[0].name).toBe('get_weather')
    expect(JSON.parse(calls[0].arguments)).toEqual({ city: '重庆' })
    expect(events.some((e) => e.type === 'stop_reason' && e.reason === 'tool_use')).toBe(true)
  })

  it('does not fabricate a tool_call when JSON is incomplete (interrupt)', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ])
    // Incomplete JSON → no tool_call emitted (but native block retained for diagnostics)
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0)
  })

  it('supports multiple tool_use blocks with distinct ids', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'a', input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'b', input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    ])
    const calls = events.filter((e) => e.type === 'tool_call') as Array<{ callId: string; name: string }>
    expect(calls.map((c) => c.callId)).toEqual(['toolu_a', 'toolu_b'])
  })

  it('usage is cumulative, not additive (later snapshot overrides)', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 10, output_tokens: 1 } } }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    const usages = events.filter((e) => e.type === 'usage') as Array<{ usage: { inputTokens?: number; outputTokens?: number } }>
    const last = usages[usages.length - 1].usage
    // Final snapshot: output 50 (not 1 + 50), input preserved from message_start
    expect(last.outputTokens).toBe(50)
    expect(last.inputTokens).toBe(10)
  })

  it('emits an error event on in-stream error and marks not completed', () => {
    const p = new AnthropicStreamParser()
    const out: CanonicalModelEvent[] = []
    out.push(...p.handle(sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } })))
    out.push(...p.handle(sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } })))
    const err = out.find((e) => e.type === 'error') as { code: string; message: string }
    expect(err.code).toBe('overloaded_error')
    expect(p.hasErrored()).toBe(true)
    expect(p.getResult().completed).toBe(false)
  })

  it('tolerates unknown event and delta types without breaking later known events', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'mystery_delta', x: 1 } }),
      { event: 'some_new_event', data: '{"type":"some_new_event"}' },
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    expect(joinText(events)).toBe('ok')
  })

  it('ignores malformed JSON data without throwing', () => {
    const p = new AnthropicStreamParser()
    expect(() => p.handle({ event: 'content_block_delta', data: '{not json' })).not.toThrow()
    expect(p.handle({ event: 'content_block_delta', data: '{not json' })).toEqual([])
  })

  it('records stop_reason unknown values verbatim', () => {
    const events = run([
      sse('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } }),
      sse('message_stop', { type: 'message_stop' }),
    ])
    expect(events.some((e) => e.type === 'stop_reason' && e.reason === 'model_context_window_exceeded')).toBe(true)
  })
})