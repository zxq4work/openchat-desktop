import { describe, it, expect } from 'vitest'
import { AnthropicSSEDecoder } from './AnthropicSSEDecoder'

const enc = (s: string) => new TextEncoder().encode(s)

function decodeAll(chunks: Uint8Array[]): Array<{ event: string; data: string }> {
  const d = new AnthropicSSEDecoder()
  const out: Array<{ event: string; data: string }> = []
  for (const c of chunks) out.push(...d.feed(c))
  out.push(...d.flush())
  return out
}

describe('AnthropicSSEDecoder', () => {
  it('parses a simple event', () => {
    const ev = decodeAll([enc('event: content_block_delta\ndata: {"type":"x"}\n\n')])
    expect(ev).toEqual([{ event: 'content_block_delta', data: '{"type":"x"}' }])
  })

  it('handles \\r\\n separators', () => {
    const ev = decodeAll([enc('event: ping\r\ndata: {"type":"ping"}\r\n\r\n')])
    expect(ev).toEqual([{ event: 'ping', data: '{"type":"ping"}' }])
  })

  it('handles multiple events in one chunk', () => {
    const ev = decodeAll([enc('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')])
    expect(ev.map((e) => e.event)).toEqual(['a', 'b'])
    expect(ev.map((e) => e.data)).toEqual(['1', '2'])
  })

  it('handles events split across chunks', () => {
    const ev = decodeAll([enc('event: delta\nda'), enc('ta: {"a":1}\n'), enc('\n')])
    expect(ev).toEqual([{ event: 'delta', data: '{"a":1}' }])
  })

  it('handles UTF-8 multibyte split across chunks', () => {
    const bytes = enc('event: text\ndata: 你好，世界\n\n')
    // Split in the middle of a multibyte char
    const mid = 20
    const ev = decodeAll([bytes.slice(0, mid), bytes.slice(mid)])
    expect(ev).toHaveLength(1)
    expect(ev[0].data).toBe('你好，世界')
  })

  it('concatenates multi-line data with newline', () => {
    const ev = decodeAll([enc('event: x\ndata: line1\ndata: line2\n\n')])
    expect(ev[0].data).toBe('line1\nline2')
  })

  it('ignores comment lines and blank unknown fields', () => {
    const ev = decodeAll([enc(': heartbeat\nevent: x\ndata: v\nid: 1\n\n')])
    expect(ev).toEqual([{ event: 'x', data: 'v' }])
  })

  it('supports data: without a space', () => {
    const ev = decodeAll([enc('event: x\ndata:{"a":1}\n\n')])
    expect(ev[0].data).toBe('{"a":1}')
  })

  it('flushes a trailing event with no terminating blank line (legal EOF)', () => {
    const ev = decodeAll([enc('event: message_stop\ndata: {"type":"message_stop"}')])
    expect(ev).toEqual([{ event: 'message_stop', data: '{"type":"message_stop"}' }])
  })

  it('drops events with no data', () => {
    const ev = decodeAll([enc('event: ping\n\n')])
    expect(ev).toEqual([])
  })

  it('handles one event delivered byte-by-byte', () => {
    const bytes = enc('event: x\ndata: {"a":1}\n\n')
    const chunks = Array.from(bytes).map((b) => new Uint8Array([b]))
    const ev = decodeAll(chunks)
    expect(ev).toEqual([{ event: 'x', data: '{"a":1}' }])
  })
})