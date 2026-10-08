import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// ChatGPTCodexClient 经 httpsClient 间接依赖 electron net/session（system 代理模式）。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

// 可控传输桩：createRequest 返回「永不主动响应」的请求对象；测试用 req.respond(res) 手动
// 交付响应头，再用 FakeResponse 手动发 data / end / aborted / close。
// destroy() 刻意不 emit error —— 精确复现 Electron net（abort 只 emit abort+close，
// 响应 emit aborted）与 Node 对已收响应 destroy() 只 emit aborted 的语义。
// 捕获 write() 的 body，用于断言实际进入的分支（Hosted 会带 hosted web_search tool）。
const orchestrator = vi.hoisted(() => ({
  lastRequest: null as null | { respond: (res: unknown) => void; body: string },
}))

vi.mock('../httpsClient', () => ({
  createRequest: (_opts: unknown, cb: (res: unknown) => void) => {
    const record = { respond: (res: unknown) => cb(res), body: '' }
    orchestrator.lastRequest = record
    return {
      write: (data?: string) => { record.body += data ?? '' },
      end: () => {},
      destroy: () => { /* 真实语义：不 emit error */ },
      on: () => {},
    }
  },
}))

import { RealChatGPTCodexClient, type ResponsesSSEEvent } from './ChatGPTCodexClient'

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
}

const credentials = { getAccessToken: async () => 'tok', getAccountId: async () => 'acc' } as never

const REQUEST = { model: 'gpt-5', instructions: '', input: [] }

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await tick()
  }
}

function withTimeout<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: generator did not settle')), ms)),
  ])
}

// 启动一次 sendResponses，返回可编排的 handle（不自动交付响应头）。
function beginStream(signal: AbortSignal): {
  events: ResponsesSSEEvent[]
  settled: Promise<{ error: Error | null }>
} {
  const client = new RealChatGPTCodexClient(credentials)
  const events: ResponsesSSEEvent[] = []
  let done!: (v: { error: Error | null }) => void
  const settled = new Promise<{ error: Error | null }>((resolve) => { done = resolve })
  void (async () => {
    try {
      for await (const ev of client.sendResponses(REQUEST, signal)) events.push(ev)
      done({ error: null })
    } catch (err) {
      done({ error: err as Error })
    }
  })()
  return { events, settled }
}

// sendResponses 首个 await 是 getAccessToken，故 createRequest 只在若干微任务后才发生；
// 必须轮询等待请求建立，避免在监听器注册前 abort。
async function waitForRequest(): Promise<{ respond: (res: unknown) => void; body: string }> {
  await waitFor(() => orchestrator.lastRequest !== null)
  return orchestrator.lastRequest!
}

// 交付响应头，并在生产代码注册 data 监听器后 resolve（事件驱动，替代固定 sleep）。
async function respondAndReady(req: { respond: (res: unknown) => void }, res: EventEmitter): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    const orig = res.on.bind(res)
    ;(res as unknown as { on: typeof res.on }).on = ((ev: string, fn: (...a: unknown[]) => void) => {
      const ret = orig(ev, fn)
      if (ev === 'data') resolve()
      return ret
    }) as typeof res.on
  })
  req.respond(res)
  await ready
}

const codexDelta = (text: string) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`

describe('RealChatGPTCodexClient.streamRequest — SSE 取消与异常关闭语义', () => {
  beforeEach(() => {
    orchestrator.lastRequest = null
  })

  it('阶段1：请求已建立、尚未收到响应头时取消 → 有限时间内以 Aborted 结束，不产出事件', async () => {
    const controller = new AbortController()
    const { events, settled } = beginStream(controller.signal)
    await waitForRequest()
    controller.abort()
    const { error } = await withTimeout(settled)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('Aborted')
    expect(events).toHaveLength(0)
  })

  it('阶段2：响应头已到、正文无数据时 abort（仅 aborted/close，不发 error）→ 以 AbortError 结束', async () => {
    const controller = new AbortController()
    const { settled } = beginStream(controller.signal)
    const req = await waitForRequest()
    const res = new FakeResponse()
    await respondAndReady(req, res)
    // Electron/Node abort 语义：不发 error，只发 aborted + close
    controller.signal.addEventListener('abort', () => {
      res.emit('aborted')
      res.emit('close')
    })
    controller.abort()
    const { error } = await withTimeout(settled)
    expect(error?.name).toBe('AbortError')
    expect(error?.message).toBe('Aborted')
  })

  it('阶段3：已收部分数据、等待下一段时 abort → 结束且不产出取消后到达的数据', async () => {
    const controller = new AbortController()
    const { events, settled } = beginStream(controller.signal)
    const req = await waitForRequest()
    const res = new FakeResponse()
    await respondAndReady(req, res)
    res.emit('data', Buffer.from(codexDelta('hello')))
    await waitFor(() => events.length > 0)
    controller.signal.addEventListener('abort', () => {
      res.emit('aborted')
      res.emit('close')
    })
    controller.abort()
    const { error } = await withTimeout(settled)
    expect(error?.name).toBe('AbortError')
    res.emit('data', Buffer.from(codexDelta('SHOULD_NOT_APPEAR')))
    const texts = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => (e as { delta: string }).delta)
      .join('')
    expect(texts).toContain('hello')
    expect(texts).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('响应异常关闭（close 早于 end，非取消）→ 以错误结束而非静默完成', async () => {
    const controller = new AbortController()
    const { settled } = beginStream(controller.signal)
    const req = await waitForRequest()
    const res = new FakeResponse()
    await respondAndReady(req, res)
    res.emit('close') // 网络中途断开，无 end、无 error、未 abort
    const { error } = await withTimeout(settled)
    expect(error).toBeInstanceOf(Error)
    expect(error?.name).not.toBe('AbortError')
    expect(error?.message).toMatch(/closed unexpectedly/i)
  })

  it('响应对象 aborted（非取消，且无 end/error）→ 以错误结束', async () => {
    const controller = new AbortController()
    const { settled } = beginStream(controller.signal)
    const req = await waitForRequest()
    const res = new FakeResponse()
    await respondAndReady(req, res)
    res.emit('aborted') // 无 end、无 error、未 abort
    const { error } = await withTimeout(settled)
    expect(error).toBeInstanceOf(Error)
    expect(error?.name).not.toBe('AbortError')
    expect(error?.message).toMatch(/aborted unexpectedly/i)
  })

  it('正常结束（end）不受影响：仍产出事件并正常收尾', async () => {
    const controller = new AbortController()
    const { events, settled } = beginStream(controller.signal)
    const req = await waitForRequest()
    const res = new FakeResponse()
    await respondAndReady(req, res)
    res.emit('data', Buffer.from(codexDelta('ok')))
    res.emit('end')
    const { error } = await withTimeout(settled)
    expect(error).toBeNull()
    // end 之后的 close 不应被判为异常
    res.emit('close')
    const texts = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => (e as { delta: string }).delta)
      .join('')
    expect(texts).toContain('ok')
  })
})
