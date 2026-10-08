import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'

// 主进程依赖 electron 的 net/session（httpsClient）与 nativeImage（AttachmentService）。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
  nativeImage: { createFromBuffer: vi.fn() },
}))

// 可控传输桩：createRequest 立即返回请求对象；测试手动交付响应头与 SSE 事件。
// destroy() 刻意只对响应 emit aborted+close、不发 error —— 复现 Electron net / Node 的 abort 语义。
// record.body 捕获实际发送的 body，用于断言请求进入了哪条生成分支（Hosted 会带 hosted web_search tool）。
const net = vi.hoisted(() => ({
  lastRequest: null as null | {
    res: EventEmitter & { statusCode: number; headers: Record<string, string> }
    respond: () => void
    body: string
  },
}))

vi.mock('./httpsClient', () => ({
  createRequest: (_opts: unknown, cb: (res: unknown) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> }
    res.statusCode = 200
    res.headers = {}
    const record = { res, respond: () => cb(res), body: '' }
    net.lastRequest = record
    return {
      write: (data?: string) => { record.body += data ?? '' },
      end: () => {},
      destroy: () => { res.emit('aborted'); res.emit('close') }, // 不发 error
      on: () => {},
    }
  },
}))

import { StorageService } from '../../storage/StorageService'
import { ConversationRepository } from '../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../storage/ContextSegmentRepository'
import { ChatGPTConversationService } from './ChatGPTConversationService'
import { RealChatGPTCodexClient } from './transport/ChatGPTCodexClient'
import type { Conversation, ContextSegment } from '../../../shared/types/conversation'

type ServiceInternals = { activeGeneration: { assistantMessageId: string } | null }

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now()
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(poll, 1)
    }
    poll()
  })
}

const sse = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`

function activeLock(service: ChatGPTConversationService): { assistantMessageId: string } | null {
  return (service as unknown as ServiceInternals).activeGeneration
}

async function setup(overrides: Partial<Conversation> = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-cancel-'))
  const storage = new StorageService(join(dir, 'openchat.db'))
  await storage.init()

  const conversations = new ConversationRepository(storage)
  const segments = new ContextSegmentRepository(storage)
  const now = Date.now()

  const conversation: Conversation = {
    id: 'conv-1', type: 'chat', title: '新对话', systemPrompt: '', systemPromptRevision: 0,
    defaultModelId: 'gpt-5', defaultReasoningEffort: null, currentSegmentId: 'seg-1',
    useModelInstructions: false, webSearchEnabled: false, codexSearchMode: 'hosted', searchEngine: 'bing',
    providerConfigId: null, defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
    providerNameSnapshot: null, modelNameSnapshot: null, requestParameterValues: {}, createdAt: now, updatedAt: now,
    ...overrides,
  }
  conversations.create(conversation)
  const segment: ContextSegment = {
    id: 'seg-1', conversationId: 'conv-1', sequence: 1, reason: 'conversation-created',
    providerThreadId: null, systemPromptRevision: 0, systemPromptSnapshot: '', createdAt: now,
  }
  segments.create(segment)

  const credentialManager = {
    getAccessToken: async () => 'tok',
    getAccountId: async () => 'acc',
  } as never
  const codexClient = new RealChatGPTCodexClient(credentialManager)

  const modelService = {
    currentModels: [],
    getModelInfo: () => undefined,
    getInstructionsTemplate: () => null,
  } as never
  const usageService = { getState: () => ({ state: 'ok' }), refresh: async () => {}, markExhaustedFrom429: () => {} } as never
  const toolRegistry = { getDefinitions: () => [], getExecutor: () => undefined, has: () => false } as never
  const webSearchService = { getEngineName: () => 'bing', setEngine: () => {}, search: async () => [], setMaxResults: () => {} } as never
  const providerConfigService = { listSafe: () => [], getAdapter: () => { throw new Error('unused') }, getBaseUrl: () => null, getResolvedRequestParameters: () => [] } as never

  const service = new ChatGPTConversationService(
    storage, codexClient, modelService as never, credentialManager, usageService as never,
    toolRegistry as never, webSearchService as never, providerConfigService as never
  )

  return { service, storage, conversations, segments }
}

// 交付响应头，并在 Codex 客户端注册 data 监听器后 resolve —— 事件驱动，替代固定 sleep。
// （streamRequest 是先 await 响应头，再 stream.on('data'...) 与读取循环；但生成器在 await
//   续体里才注册监听器，respond() 只是以微任务 resolve，故不能立即投递事件。）
async function respondAndReady(handle: typeof net.lastRequest): Promise<void> {
  const rec = handle!
  const res = rec.res
  const ready = new Promise<void>((resolve) => {
    const orig = res.on.bind(res)
    ;(res as unknown as { on: unknown }).on = ((ev: string, fn: (...a: unknown[]) => void) => {
      const ret = orig(ev, fn)
      if (ev === 'data') resolve()
      return ret
    }) as typeof res.on
  })
  rec.respond()
  await ready
}

// 完成一次 sendMessage 的启动：等待底层请求建立并交付响应头（事件驱动就绪）。
async function sendAndRespondHeader(service: ChatGPTConversationService, text: string) {
  const result = await service.sendMessage('conv-1', text)
  await waitFor(() => net.lastRequest !== null)
  const handle = net.lastRequest!
  net.lastRequest = null
  await respondAndReady(handle)
  return { ...result, handle }
}

function assistantContent(service: ChatGPTConversationService, assistantMessageId: string): string | undefined {
  return service.getConversation('conv-1')?.messages.find((m) => m.id === assistantMessageId)?.content
}
function assistantStatus(service: ChatGPTConversationService, assistantMessageId: string): string | undefined {
  return service.getConversation('conv-1')?.messages.find((m) => m.id === assistantMessageId)?.status
}

describe('ChatGPTConversationService — 停止生成后任务锁释放', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    net.lastRequest = null
    ctx = await setup()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  // 本 describe 的默认会话为 providerConfigId=null + webSearchEnabled=false
  // → resolveSearchStrategy = 'none' → 走 runGenerationDirect（非 Hosted）。
  it('SSE 响应头已到、正文等待期间 interrupt → runGeneration 退出并释放 activeGeneration', async () => {
    const { assistantMessage, handle } = await sendAndRespondHeader(ctx.service, 'hi')
    expect(activeLock(ctx.service)).not.toBeNull()

    await ctx.service.interrupt()

    await waitFor(() => activeLock(ctx.service) === null)
    expect(assistantStatus(ctx.service, assistantMessage.id)).toBe('stopped')
    // 迟到的响应事件不再被消费（bridge 已 cleanup，生成器已退出）
    handle.res.emit('data', Buffer.from(sse({ type: 'response.output_text.delta', delta: 'LATE' })))
    expect(assistantContent(ctx.service, assistantMessage.id)).not.toContain('LATE')
  })

  it('停止后立即重发（不等待锁释放）：不卡死，锁释放且第二次生成完成', async () => {
    const first = await sendAndRespondHeader(ctx.service, 'first')
    await ctx.service.interrupt()

    // 立即重发：绝不对「旧生成锁释放」做任何等待。
    // 真实行为：interrupt() 只 abort，锁由 runGeneration.finally 在终止链上异步释放，
    // 因此同刻重发可能命中瞬态「已有正在进行的生成」——这是设计内的，不是缺陷；
    // 关键不变量是锁必须尽快释放、且不得永久卡死。
    const second = await (async () => {
      try {
        return await ctx.service.sendMessage('conv-1', 'second')
      } catch (e) {
        // 唯一允许的瞬态失败必须精确是该锁提示；任何其它错误都要显式失败
        expect((e as Error).message).toBe('已有正在进行的生成')
        // 瞬态拒绝 → 锁随后必须释放（回归要点：修复前此锁永不释放，waitFor 会超时）
        await waitFor(() => activeLock(ctx.service) === null)
        return await ctx.service.sendMessage('conv-1', 'second')
      }
    })()
    expect(assistantStatus(ctx.service, first.assistantMessage.id)).toBe('stopped')

    // 让第二次生成真正跑起来并完成
    await waitFor(() => net.lastRequest !== null)
    const handle = net.lastRequest!
    net.lastRequest = null
    await respondAndReady(handle)
    handle.res.emit('data', Buffer.from(sse({ type: 'response.created', response: { id: 'r2' } })))
    handle.res.emit('data', Buffer.from(sse({ type: 'response.output_text.delta', delta: 'SECOND_OK' })))
    handle.res.emit('data', Buffer.from(sse({ type: 'response.completed', response: {} })))
    handle.res.emit('end')
    await waitFor(() => activeLock(ctx.service) === null)
    expect(assistantContent(ctx.service, second.assistantMessage.id)).toContain('SECOND_OK')
  })

  it('旧请求迟到返回不会污染新生成结果', async () => {
    // gen1（direct 分支）：进入读取等待后被中断
    const first = await sendAndRespondHeader(ctx.service, 'first')
    await ctx.service.interrupt()
    await waitFor(() => activeLock(ctx.service) === null)

    // gen2 正常生成
    const second = await ctx.service.sendMessage('conv-1', 'second')
    await waitFor(() => net.lastRequest !== null)
    const h2 = net.lastRequest!
    net.lastRequest = null
    await respondAndReady(h2)
    h2.res.emit('data', Buffer.from(sse({ type: 'response.output_text.delta', delta: 'NEW' })))
    h2.res.emit('data', Buffer.from(sse({ type: 'response.completed', response: {} })))
    h2.res.emit('end')
    await waitFor(() => activeLock(ctx.service) === null)

    // gen1 的旧响应此刻才“迟到”返回。生成器已退出，其 data 监听器无人消费，
    // 事件同步无副作用；下一宏任务拍清空待处理微任务后即可断言。
    first.handle.res.emit('data', Buffer.from(sse({ type: 'response.output_text.delta', delta: 'OLD_LATE' })))
    first.handle.res.emit('end')
    await new Promise((r) => setImmediate(r))

    const secondContent = assistantContent(ctx.service, second.assistantMessage.id) ?? ''
    expect(secondContent).toContain('NEW')
    expect(secondContent).not.toContain('OLD_LATE')
    // gen1 的 assistant 消息仍是已停止状态，未被旧响应改写为 completed
    expect(assistantStatus(ctx.service, first.assistantMessage.id)).toBe('stopped')
  })

  it('Hosted 搜索分支：响应头已到、等待搜索正文时 interrupt 同样释放 activeGeneration', async () => {
    // 与默认会话不同：webSearchEnabled=true + codexSearchMode='hosted'
    // → resolveSearchStrategy = 'codex-hosted' → runGenerationWithCodexHostedSearch。
    const hostedCtx = await setup({ webSearchEnabled: true, codexSearchMode: 'hosted' })
    // 分支证明：Hosted 请求体携带 hosted web_search tool（direct 分支绝不带 tools）。
    const { assistantMessage, handle } = await sendAndRespondHeader(hostedCtx.service, '联网搜索')
    const body = JSON.parse(handle.body) as { tools?: Array<{ type?: string }> }
    expect(body.tools?.some((t) => t.type === 'web_search')).toBe(true)
    expect(activeLock(hostedCtx.service)).not.toBeNull()

    await hostedCtx.service.interrupt()

    await waitFor(() => activeLock(hostedCtx.service) === null)
    expect(assistantStatus(hostedCtx.service, assistantMessage.id)).toBe('stopped')
  })
})
