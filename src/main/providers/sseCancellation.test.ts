import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// 三个 SSE 适配器都经 httpsClient 间接依赖 electron net/session。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

// 可控传输桩：createRequest 返回一个「永不主动响应」的请求对象；
// 测试用编排器 orchestrator.respond(res) 手动交付响应头，
// 用 FakeResponse 手动发 data / end / error / close / aborted。
// destroy() 刻意不 emit error —— 精确复现 Electron net 与 Node 对已收响应在 abort 时的语义。
const orchestrator = vi.hoisted(() => ({
  lastRequest: null as null | {
    respond: (res: unknown) => void
    destroy: () => void
  },
}))

vi.mock('../openai/chatgpt/httpsClient', () => ({
  createRequest: (_opts: unknown, cb: (res: unknown) => void) => {
    const record = {
      respond: (res: unknown) => cb(res),
      destroy: () => { /* 真实语义：不 emit error */ },
    }
    orchestrator.lastRequest = record
    return {
      write: () => {},
      end: () => {},
      destroy: () => record.destroy(),
      on: () => {},
    }
  },
}))

import { ChatCompletionsAdapter } from './ChatCompletionsAdapter'
import { ResponsesAdapter } from './ResponsesAdapter'
import type { CanonicalModelEvent } from '../../shared/types/provider'

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
}

type AdapterKind = 'cc' | 'resp'

function makeAdapter(kind: AdapterKind) {
  if (kind === 'cc') {
    return new ChatCompletionsAdapter({ baseUrl: 'https://x/v1', apiKey: 'k', toolCalling: true })
  }
  return new ResponsesAdapter({ baseUrl: 'https://x/v1', apiKey: 'k', toolCalling: true })
}

interface StreamHandle {
  res: FakeResponse
  events: CanonicalModelEvent[]
  settled: Promise<{ error: Error | null }>
}

// 启动一次 stream，并手动把响应头交付底层回调，返回可编排的 handle。
async function startStream(kind: AdapterKind, signal: AbortSignal): Promise<StreamHandle> {
  const adapter = makeAdapter(kind)
  const events: CanonicalModelEvent[] = []
  const res = new FakeResponse()
  let done!: (v: { error: Error | null }) => void
  const settled = new Promise<{ error: Error | null }>((resolve) => { done = resolve })

  void (async () => {
    try {
      for await (const ev of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, signal)) {
        events.push(ev)
      }
      done({ error: null })
    } catch (err) {
      done({ error: err as Error })
    }
  })()

  // 轮询等待 stream() 内部建立请求，再交付响应头。
  for (let i = 0; i < 100 && !orchestrator.lastRequest; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  const req = orchestrator.lastRequest
  if (!req) throw new Error('createRequest was never called')
  req.respond(res)
  // 让 stream() 的 await 续体推进到读取循环（微任务 + 一个宏任务拍）。
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))

  return { res, events, settled }
}

function withTimeout<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: generator did not settle')), ms)),
  ])
}

const ccDelta = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`
const respDelta = (text: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`

const KINDS: AdapterKind[] = ['cc', 'resp']
const deltaFor = (k: AdapterKind) => (k === 'cc' ? ccDelta : respDelta)

describe.each(KINDS)('%s — SSE 取消语义', (kind) => {
  beforeEach(() => {
    orchestrator.lastRequest = null
  })

  it('阶段1：请求未收到响应时取消 → 有限时间内以 AbortError 结束', async () => {
    const controller = new AbortController()
    const adapter = makeAdapter(kind)
    const events: CanonicalModelEvent[] = []
    const promise = (async () => {
      try {
        for await (const ev of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, controller.signal)) {
          events.push(ev)
        }
        return null
      } catch (err) {
        return err as Error
      }
    })()
    // 请求已发出但绝不响应 → 直接取消
    controller.abort()
    const error = await withTimeout(promise)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Aborted')
    expect(events).toHaveLength(0)
  })

  it('阶段2：已收响应头、正文无数据时取消（仅 close/aborted，不发 error）→ 有限时间结束', async () => {
    const controller = new AbortController()
    const handle = await startStream(kind, controller.signal)
    // Electron/Node abort 语义：不发 error，只发 aborted + close
    controller.signal.addEventListener('abort', () => {
      handle.res.emit('aborted')
      handle.res.emit('close')
    })
    controller.abort()
    const { error } = await withTimeout(handle.settled)
    expect((error as Error)?.message).toBe('Aborted')
  })

  it('阶段3：已收部分数据、等待下一段时取消 → 结束且不产出取消后到达的数据', async () => {
    const controller = new AbortController()
    const handle = await startStream(kind, controller.signal)
    handle.res.emit('data', Buffer.from(deltaFor(kind)('hello')))
    await Promise.resolve()
    controller.signal.addEventListener('abort', () => {
      handle.res.emit('aborted')
      handle.res.emit('close')
    })
    controller.abort()
    const { error } = await withTimeout(handle.settled)
    expect((error as Error)?.message).toBe('Aborted')
    // 取消后迟到的数据不得产出
    handle.res.emit('data', Buffer.from(deltaFor(kind)('SHOULD_NOT_APPEAR')))
    const texts = handle.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(texts).toContain('hello')
    expect(texts).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('响应异常关闭（close 早于 end，非取消）→ 以错误结束而非静默完成', async () => {
    const controller = new AbortController()
    const handle = await startStream(kind, controller.signal)
    handle.res.emit('close') // 网络中途断开，无 end、无 error
    const { error } = await withTimeout(handle.settled)
    expect(error).toBeInstanceOf(Error)
    expect(error?.name).not.toBe('AbortError')
    expect(error?.message).toMatch(/closed unexpectedly/i)
  })

  it('正常结束（end）不受影响：仍产出事件并正常收尾', async () => {
    const controller = new AbortController()
    const handle = await startStream(kind, controller.signal)
    handle.res.emit('data', Buffer.from(deltaFor(kind)('ok')))
    handle.res.emit('end')
    const { error } = await withTimeout(handle.settled)
    expect(error).toBeNull()
    // 不应因 end 后的 close 误判为异常
    handle.res.emit('close')
    const texts = handle.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')
    expect(texts).toContain('ok')
  })
})
