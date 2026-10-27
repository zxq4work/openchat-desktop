import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// Adapter 经 httpsClient 间接依赖 electron net/session。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

// 可控传输桩：记录请求选项；测试手动交付响应。
const orchestrator = vi.hoisted(() => ({
  lastOptions: null as null | Record<string, unknown>,
  lastRequest: null as null | { respond: (res: unknown) => void; destroy: () => void; body?: string },
}))

vi.mock('../../openai/chatgpt/httpsClient', () => ({
  createRequest: (opts: Record<string, unknown>, cb: (res: unknown) => void) => {
    orchestrator.lastOptions = opts
    const record = {
      respond: (res: unknown) => cb(res),
      destroy: () => { /* Electron/Node abort: no error emitted */ },
      body: '',
    }
    orchestrator.lastRequest = record
    return {
      write: (chunk: string) => { record.body += chunk },
      end: () => {},
      destroy: () => record.destroy(),
      on: () => {},
    }
  },
}))

import { AnthropicMessagesAdapter } from './AnthropicMessagesAdapter'
import type { CanonicalModelEvent } from '../../../shared/types/provider'

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
}

const enc = (s: string) => Buffer.from(s, 'utf-8')

function sseBlock(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

async function startStream(
  adapter: AnthropicMessagesAdapter,
  signal?: AbortSignal
): Promise<{ res: FakeResponse; events: CanonicalModelEvent[]; settled: Promise<{ error: Error | null }>; req: NonNullable<typeof orchestrator.lastRequest> }> {
  const events: CanonicalModelEvent[] = []
  const res = new FakeResponse()
  let done!: (v: { error: Error | null }) => void
  const settled = new Promise<{ error: Error | null }>((resolve) => { done = resolve })

  void (async () => {
    try {
      for await (const ev of adapter.stream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, signal)) {
        events.push(ev)
      }
      done({ error: null })
    } catch (err) {
      done({ error: err as Error })
    }
  })()

  for (let i = 0; i < 100 && !orchestrator.lastRequest; i++) await new Promise((r) => setTimeout(r, 1))
  const req = orchestrator.lastRequest
  if (!req) throw new Error('createRequest never called')
  req.respond(res)
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  return { res, events, settled, req }
}

function withTimeout<T>(p: Promise<T>, ms = 800): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))])
}

// 向已捕获的请求交付一个正常结束的流。
// 关键：respond() 只解析等待响应头的 Promise，stream() 的读取循环在随后微任务里才挂上
// data/end 监听器 —— 必须让出事件循环后再 emit，否则事件丢失、读取循环永久等待。
async function finishStream(req: NonNullable<typeof orchestrator.lastRequest>): Promise<void> {
  const res = new FakeResponse()
  req.respond(res)
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  res.emit('data', enc(sseBlock('message_stop', { type: 'message_stop' })))
  res.emit('end')
}

beforeEach(() => {
  orchestrator.lastOptions = null
  orchestrator.lastRequest = null
})

describe('AnthropicMessagesAdapter — stream', () => {
  it('builds URL and headers correctly (x-api-key default)', async () => {
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'sk-test', toolCalling: true })
    const { res, settled } = await startStream(adapter)
    res.emit('end')
    await withTimeout(settled)
    const opts = orchestrator.lastOptions!
    expect(opts.path).toBe('/v1/messages')
    const headers = opts.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('uses Bearer auth when configured', async () => {
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'sk-test', toolCalling: true, authMode: 'bearer', apiVersion: '2024-01-01' })
    const { res, settled } = await startStream(adapter)
    res.emit('end')
    await withTimeout(settled)
    const headers = orchestrator.lastOptions!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2024-01-01')
  })

  it('parses a full text stream into delta + usage + turn_completed', async () => {
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
    const { res, events, settled } = await startStream(adapter)
    res.emit('data', enc(
      sseBlock('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'test-model', usage: { input_tokens: 12, output_tokens: 1 } } }) +
      sseBlock('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseBlock('ping', { type: 'ping' }) +
      sseBlock('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }) +
      sseBlock('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，OpenChat！' } }) +
      sseBlock('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sseBlock('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } }) +
      sseBlock('message_stop', { type: 'message_stop' })
    ))
    res.emit('end')
    const { error } = await withTimeout(settled)
    expect(error).toBeNull()
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('你好，OpenChat！')
    expect(events.some((e) => e.type === 'turn_completed' && e.turnId === 'msg_1')).toBe(true)
  })

  it('emits error (not completion) when stream ends without message_stop', async () => {
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
    const { res, events, settled } = await startStream(adapter)
    res.emit('data', enc(
      sseBlock('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }) +
      sseBlock('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseBlock('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })
    ))
    res.emit('end')
    const { error } = await withTimeout(settled)
    expect(error).toBeNull()
    expect(events.some((e) => e.type === 'error' && (e as { code: string }).code === 'ANTHROPIC_STREAM_INCOMPLETE')).toBe(true)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
  })

  it('surfaces in-stream error and never completes', async () => {
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
    const { res, events, settled } = await startStream(adapter)
    res.emit('data', enc(
      sseBlock('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }) +
      sseBlock('error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } })
    ))
    res.emit('end')
    await withTimeout(settled)
    expect(events.some((e) => e.type === 'error' && (e as { code: string }).code === 'overloaded_error')).toBe(true)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
  })

  it('abort mid-stream ends with AbortError and drops late data', async () => {
    const controller = new AbortController()
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
    const { res, events, settled } = await startStream(adapter, controller.signal)
    res.emit('data', enc(
      sseBlock('message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }) +
      sseBlock('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseBlock('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })
    ))
    await Promise.resolve()
    controller.signal.addEventListener('abort', () => { res.emit('aborted'); res.emit('close') })
    controller.abort()
    const { error } = await withTimeout(settled)
    expect((error as Error)?.message).toBe('Aborted')
    res.emit('data', enc(sseBlock('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE' } })))
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toContain('hello')
    expect(text).not.toContain('LATE')
  })

  it('maps HTTP error status into an error event', async () => {
    const adapter = new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
    const events: CanonicalModelEvent[] = []
    const errRes = new FakeResponse()
    errRes.statusCode = 401
    const p = (async () => {
      for await (const ev of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev)
    })()
    for (let i = 0; i < 100 && !orchestrator.lastRequest; i++) await new Promise((r) => setTimeout(r, 1))
    orchestrator.lastRequest!.respond(errRes)
    errRes.emit('data', enc(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } })))
    errRes.emit('end')
    await withTimeout(p)
    const err = events.find((e) => e.type === 'error') as { code: string } | undefined
    expect(err?.code).toBe('ANTHROPIC_AUTH_ERROR')
  })

  it('final HTTP body contains output_config.effort directly from reasoningEffort (no switch)', async () => {
    const adapter = new AnthropicMessagesAdapter({
      baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true,
    })
    const events: CanonicalModelEvent[] = []
    const p = (async () => {
      for await (const ev of adapter.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        reasoningEffort: 'medium',
      })) events.push(ev)
    })()
    for (let i = 0; i < 100 && !orchestrator.lastRequest; i++) await new Promise((r) => setTimeout(r, 1))
    const req = orchestrator.lastRequest!
    const body = JSON.parse(req.body as string) as Record<string, unknown>
    expect(body.output_config).toEqual({ effort: 'medium' })
    await finishStream(req)
    await withTimeout(p)
  })

  it('no output_config when no effort selected', async () => {
    const adapter = new AnthropicMessagesAdapter({
      baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true,
    })
    const p = (async () => {
      for await (const _ev of adapter.stream({
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
      })) { /* drain */ }
    })()
    for (let i = 0; i < 100 && !orchestrator.lastRequest; i++) await new Promise((r) => setTimeout(r, 1))
    const req = orchestrator.lastRequest!
    const body = JSON.parse(req.body as string) as Record<string, unknown>
    expect(body.output_config).toBeUndefined()
    await finishStream(req)
    await withTimeout(p)
  })
})