import { describe, it, expect } from 'vitest'
import { normalizeAnthropicResponse } from './AnthropicResponseNormalizer'
import type { CanonicalModelEvent } from '../../../shared/types/provider'

function text(events: CanonicalModelEvent[]): string {
  return events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
}

describe('normalizeAnthropicResponse (non-stream)', () => {
  it('extracts text and usage', () => {
    const events = normalizeAnthropicResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: '你好！有什么可以帮助你的？' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 18, output_tokens: 13 },
    })
    expect(text(events)).toBe('你好！有什么可以帮助你的？')
    const usage = events.find((e) => e.type === 'usage') as { usage: { inputTokens?: number; outputTokens?: number } }
    expect(usage.usage.inputTokens).toBe(18)
    expect(usage.usage.outputTokens).toBe(13)
    expect(events.some((e) => e.type === 'stop_reason' && e.reason === 'end_turn')).toBe(true)
  })

  it('handles thinking + text preserving order and signature', () => {
    const events = normalizeAnthropicResponse({
      content: [
        { type: 'thinking', thinking: 'summary', signature: 'sig' },
        { type: 'text', text: 'final' },
      ],
      stop_reason: 'end_turn',
    })
    expect(text(events)).toBe('final')
    const blocks = events.filter((e) => e.type === 'native_block').map((e) => (e as { block: Record<string, unknown> }).block)
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'summary', signature: 'sig' })
    expect(blocks[1]).toEqual({ type: 'text', text: 'final' })
  })

  it('extracts tool_use and keeps unknown blocks raw', () => {
    const events = normalizeAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '重庆' } },
        { type: 'future_block', foo: 'bar' },
      ],
      stop_reason: 'tool_use',
    })
    const call = events.find((e) => e.type === 'tool_call') as { callId: string; name: string; arguments: string }
    expect(call.callId).toBe('toolu_1')
    expect(JSON.parse(call.arguments)).toEqual({ city: '重庆' })
    const blocks = events.filter((e) => e.type === 'native_block').map((e) => (e as { block: Record<string, unknown> }).block)
    expect(blocks.find((b) => b.type === 'future_block')).toEqual({ type: 'future_block', foo: 'bar' })
  })

  it('does not crash on empty content', () => {
    expect(() => normalizeAnthropicResponse({ content: [] })).not.toThrow()
    expect(normalizeAnthropicResponse({})).toEqual([])
  })
})