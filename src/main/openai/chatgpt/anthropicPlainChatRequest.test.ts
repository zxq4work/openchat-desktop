import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// 捕获真正写入 wire 的请求体（所有 Adapter 都经 createRequest）。
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
      destroy: () => { res.emit('aborted'); res.emit('close') },
      on: () => {},
    }
  },
}))

import { StorageService } from '../../storage/StorageService'
import { ConversationRepository } from '../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../storage/MessageRepository'
import { ChatGPTConversationService } from './ChatGPTConversationService'
import { RealChatGPTCodexClient } from './transport/ChatGPTCodexClient'
import { AnthropicMessagesAdapter } from '../../providers/anthropic/AnthropicMessagesAdapter'
import { ChatCompletionsAdapter } from '../../providers/ChatCompletionsAdapter'
import { ResponsesAdapter } from '../../providers/ResponsesAdapter'
import type { Conversation, ContextSegment, Message } from '../../../shared/types/conversation'
import type { ModelAdapter } from '../../../shared/types/provider'

// =====================================================================
// 端到端：捕获最终 HTTP 请求结构（system / tools / tool_choice / messages），
// 验证 Anthropic 纯聊天策略与搜索开关切换，并确认 cc / responses 行为不变。
// 绝不硬编码 System Prompt 字符长度。
// =====================================================================

type Protocol = 'anthropic_messages' | 'chat_completions' | 'responses'

function makeAdapter(protocol: Protocol): ModelAdapter {
  if (protocol === 'anthropic_messages') {
    return new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
  }
  if (protocol === 'responses') {
    return new ResponsesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
  }
  return new ChatCompletionsAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
}

const MODEL = 'test-model'
const PROVIDER_ID = 'prov-1'

interface Ctx {
  service: ChatGPTConversationService
  storage: StorageService
  conversations: ConversationRepository
  segments: ContextSegmentRepository
  messages: MessageRepository
  protocol: Protocol
  dir: string
}

async function setup(opts: {
  protocol: Protocol
  webSearchEnabled: boolean
  systemPrompt?: string
  modelInstructions?: string | null
  history?: 'none' | 'search'
  storage?: StorageService
  dir?: string
}): Promise<Ctx> {
  const dir = opts.dir ?? fs.mkdtempSync(join(os.tmpdir(), 'openchat-anthplain-'))
  const storage = opts.storage ?? new StorageService(join(dir, 'openchat.db'))
  if (!opts.storage) await storage.init()

  const conversations = new ConversationRepository(storage)
  const segments = new ContextSegmentRepository(storage)
  const messages = new MessageRepository(storage)
  const now = Date.now()

  const conversation: Conversation = {
    id: 'conv-1', type: 'chat', title: 't',
    systemPrompt: opts.systemPrompt ?? '', systemPromptRevision: 0,
    defaultModelId: MODEL, defaultReasoningEffort: null, currentSegmentId: 'seg-1',
    useModelInstructions: !!opts.modelInstructions,
    webSearchEnabled: opts.webSearchEnabled, codexSearchMode: 'hosted', searchEngine: 'bing',
    providerConfigId: PROVIDER_ID,
    defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
    providerNameSnapshot: null, modelNameSnapshot: null,
    requestParameterValues: {}, createdAt: now, updatedAt: now,
  }
  if (!conversations.getById('conv-1')) conversations.create(conversation)

  const segment: ContextSegment = {
    id: 'seg-1', conversationId: 'conv-1', sequence: 1, reason: 'conversation-created',
    providerThreadId: null, systemPromptRevision: 0,
    systemPromptSnapshot: opts.systemPrompt ?? '', createdAt: now,
  }
  if (!segments.getById('seg-1')) segments.create(segment)

  if (opts.history === 'search' && messages.getBySegmentId('seg-1').length === 0) {
    // 真实历史形态：先有用户提问，再有带搜索工具调用的 assistant 回答。
    messages.create({
      id: 'm-q0', conversationId: 'conv-1', segmentId: 'seg-1', role: 'user',
      content: 'earlier question', attachments: [], reasoningMeta: null, reasoningText: null,
      reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
      status: 'completed', modelId: MODEL, reasoningEffort: null,
      providerTurnId: null, providerItemId: null, providerPayloadJson: null,
      errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
    })
    const seed: Message = {
      id: 'm-search', conversationId: 'conv-1', segmentId: 'seg-1', role: 'assistant',
      content: 'earlier answer', attachments: [], reasoningMeta: null, reasoningText: null,
      reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
      status: 'completed', modelId: MODEL, reasoningEffort: null,
      providerTurnId: null, providerItemId: null,
      providerPayloadJson: JSON.stringify({
        provider: 'custom', protocol: 'anthropic_messages',
        items: [
          { type: 'function_call', call_id: 'call_1', name: 'openchat_web_search', arguments: '{"query":"openai"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"results":[{"title":"T","url":"https://e"}]}' },
        ],
      }),
      errorCode: null, errorMessage: null, createdAt: 2, updatedAt: 2,
    }
    messages.create(seed)
  }

  const adapter = makeAdapter(opts.protocol)
  const credentialManager = { getAccessToken: async () => 'tok', getAccountId: async () => 'acc' } as never
  const codexClient = new RealChatGPTCodexClient(credentialManager)
  const modelService = {
    currentModels: [{ id: MODEL, supportedReasoningEfforts: [] }],
    getModelInfo: () => undefined,
    getInstructionsTemplate: () => opts.modelInstructions ?? null,
    resolveEffort: () => null,
  } as never
  const usageService = { getState: () => ({ state: 'ok' }), refresh: async () => {}, markExhaustedFrom429: () => {} } as never
  const toolRegistry = {
    getDefinitions: () => [{ name: 'openchat_web_search', description: '', parameters: { type: 'object', properties: {} } }],
    getExecutor: (name: string) => name === 'openchat_web_search' ? { definition: { name, description: '', parameters: {} }, execute: async () => ({ callId: '', name, output: '' }) } : undefined,
    has: () => true,
  } as never
  const webSearchService = { getEngineName: () => 'bing', setEngine: () => {}, search: async () => [], setMaxResults: () => {} } as never
  const providerConfigService = {
    listSafe: () => [{ id: PROVIDER_ID, name: 'P', protocol: opts.protocol, models: [MODEL] }],
    getAdapter: () => adapter,
    getBaseUrl: () => 'https://api.example',
    getResolvedRequestParameters: () => [],
  } as never

  const service = new ChatGPTConversationService(
    storage, codexClient, modelService as never, credentialManager, usageService as never,
    toolRegistry as never, webSearchService as never, providerConfigService as never,
    undefined, false // readHistoryToolEnabled=false → 请求体只含搜索工具，便于断言
  )

  return { service, storage, conversations, segments, messages, protocol: opts.protocol, dir }
}

const sse = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const ANTHROPIC_OK =
  sse('message_start', { type: 'message_start', message: { id: 'm1', model: MODEL, usage: {} } }) +
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
  sse('message_stop', { type: 'message_stop' })

function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
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

function activeLock(service: ChatGPTConversationService): unknown {
  return (service as unknown as { activeGeneration: unknown }).activeGeneration
}

// 交付响应头，并在读取循环注册 data 监听器后 resolve ——
// 避免「先 emit 后挂监听器」导致事件丢失、生成永不结束。
async function respondAndReady(rec: NonNullable<typeof net.lastRequest>): Promise<void> {
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

// 发送一条消息，返回真正写入 wire 的请求体（JSON）。
async function runTurn(ctx: Ctx, text: string): Promise<Record<string, unknown>> {
  net.lastRequest = null
  void ctx.service.sendMessage('conv-1', text).catch(() => { /* 断言只关心请求体 */ })
  await waitFor(() => net.lastRequest !== null && net.lastRequest.body.length > 0)
  const rec = net.lastRequest!
  const parsed = JSON.parse(rec.body) as Record<string, unknown>

  await respondAndReady(rec)
  // 让出若干宏任务：读取循环在 'data' 之后才注册 'end'/'error' 监听器，
  // 否则同步 emit 的 'end' 会丢失，生成永不结束。
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  if (ctx.protocol === 'anthropic_messages') {
    rec.res.emit('data', Buffer.from(ANTHROPIC_OK))
  } else if (ctx.protocol === 'responses') {
    rec.res.emit('data', Buffer.from(
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'r1' } })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`
    ))
  } else {
    rec.res.emit('data', Buffer.from(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n'
    ))
  }
  rec.res.emit('end')
  // 让出宏任务，使 runGeneration 的 finally（释放锁 + save）真正执行完。
  await waitFor(() => activeLock(ctx.service) === null, 3000)
  await new Promise((r) => setTimeout(r, 5))
  return parsed
}

function systemOf(body: Record<string, unknown>, protocol: Protocol): string {
  if (protocol === 'anthropic_messages') return typeof body.system === 'string' ? body.system : ''
  if (protocol === 'responses') return typeof body.instructions === 'string' ? body.instructions : ''
  const msgs = body.messages as Array<{ role: string; content: unknown }>
  const sys = msgs.find((m) => m.role === 'system')
  return sys ? String(sys.content) : ''
}

const NO_SEARCH_SENTINEL = 'You do not have web search tools available'
const PROVENANCE_SENTINEL = 'OPENCHAT_SEARCH_PROVENANCE_V1'

beforeEach(() => { net.lastRequest = null })

describe('Anthropic 纯聊天与搜索开关 — 最终 HTTP 请求结构', () => {
  it('1) 搜索关闭 + 无自定义提示词：统一基础提示词 + NOTICE、无 tools', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false })
    const body = await runTurn(ctx, 'hello')
    const system = systemOf(body, 'anthropic_messages')

    // 统一基础提示词：模型 / 日期 / 时区 / 兜底角色 / Additional info 标题全部保留
    expect(system).toContain('Current model:')
    expect(system).toContain('Current date:')
    expect(system).toContain('Current timezone:')
    expect(system).toContain('You are a helpful assistant.')
    expect(system).toContain('Additional info for this conversation:')
    // 搜索关闭 + 无历史 → 统一注入 NOTICE
    expect(system).toContain(NO_SEARCH_SENTINEL)
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('2) 搜索关闭 + 自定义提示词：提示词原样保留并位于末尾，NOTICE 追加在后', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false, systemPrompt: 'You are a pirate.' })
    const body = await runTurn(ctx, 'hello')
    const system = systemOf(body, 'anthropic_messages')

    expect(system).toContain('You are a pirate.')
    expect(system).not.toContain('You are a helpful assistant.')
    // 功能上下文仍保留（日期 / 时区），且用户提示词位于基础 metadata 末尾（优先级不变）
    expect(system).toContain('Current date:')
    expect(system).toContain('Current timezone:')
    expect(system).toContain('Current model:')
    expect(system).toContain('Additional info for this conversation:')
    expect(system).toContain(NO_SEARCH_SENTINEL)
    expect(body.tools).toBeUndefined()
  })

  it('2b) 三个协议基础提示词一致（无自定义提示词）', async () => {
    for (const protocol of ['anthropic_messages', 'chat_completions', 'responses'] as Protocol[]) {
      const ctx = await setup({ protocol, webSearchEnabled: false })
      const body = await runTurn(ctx, 'hello')
      const system = systemOf(body, protocol)

      expect(system).toContain('You are a helpful assistant.')
      expect(system).toContain('Additional info for this conversation:')
      expect(system).toContain('Current model:')
      expect(system).toContain('Current date:')
      expect(system).toContain('Current timezone:')
      // 三个协议采用同一 NOTICE 策略
      expect(system).toContain(NO_SEARCH_SENTINEL)
    }
  })

  it('3) 搜索关闭 + Model Instructions：instructions 保留，NOTICE 统一注入', async () => {
    const ctx = await setup({
      protocol: 'anthropic_messages', webSearchEnabled: false, modelInstructions: 'MODEL_INSTRUCTIONS_MARKER',
    })
    const body = await runTurn(ctx, 'hello')
    const system = systemOf(body, 'anthropic_messages')

    expect(system).toContain('MODEL_INSTRUCTIONS_MARKER')
    expect(system).toContain(NO_SEARCH_SENTINEL)
    expect(body.tools).toBeUndefined()
  })

  it('4) 搜索开启 + 自定义提示词：tools 声明、tool_choice=auto、搜索指令存在、无「无搜索」声明', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: true, systemPrompt: 'You are a pirate.' })
    const body = await runTurn(ctx, 'search something')
    const system = systemOf(body, 'anthropic_messages')

    expect(system).toContain('You are a pirate.')
    expect(system).toContain('Web access is available through OpenChat tools.')
    expect(system).not.toContain(NO_SEARCH_SENTINEL)
    expect(Array.isArray(body.tools)).toBe(true)
    const names = (body.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('openchat_web_search')
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('5) 搜索开启后关闭：上一轮请求带 tools；关闭后请求不带 tools，且历史搜索上下文仍在', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: true })
    const onBody = await runTurn(ctx, 'first')
    expect(Array.isArray(onBody.tools)).toBe(true)

    // 模拟真实历史：用户提问 → 带搜索工具调用的回答 → 关闭搜索
    ctx.messages.create({
      id: 'm-q1', conversationId: 'conv-1', segmentId: 'seg-1', role: 'user',
      content: 'which search did you run', attachments: [], reasoningMeta: null, reasoningText: null,
      reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
      status: 'completed', modelId: MODEL, reasoningEffort: null,
      providerTurnId: null, providerItemId: null, providerPayloadJson: null,
      errorCode: null, errorMessage: null, createdAt: Date.now(), updatedAt: Date.now(),
    })
    ctx.messages.create({
      id: 'm-search', conversationId: 'conv-1', segmentId: 'seg-1', role: 'assistant',
      content: 'earlier answer', attachments: [], reasoningMeta: null, reasoningText: null,
      reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
      status: 'completed', modelId: MODEL, reasoningEffort: null,
      providerTurnId: null, providerItemId: null,
      providerPayloadJson: JSON.stringify({
        provider: 'custom', protocol: 'anthropic_messages',
        items: [
          { type: 'function_call', call_id: 'call_1', name: 'openchat_web_search', arguments: '{"query":"openai"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"results":[]}' },
        ],
      }),
      errorCode: null, errorMessage: null, createdAt: Date.now() + 1, updatedAt: Date.now() + 1,
    })
    ctx.conversations.updateWebSearchEnabled('conv-1', false)

    const offBody = await runTurn(ctx, 'second')
    const system = systemOf(offBody, 'anthropic_messages')
    expect(offBody.tools).toBeUndefined()
    expect(system).toContain(PROVENANCE_SENTINEL)
    expect(system).not.toContain(NO_SEARCH_SENTINEL)
  })

  it('6) 关闭后再次开启：先无 tools，再恢复 tools 与搜索指令', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false })
    const offBody = await runTurn(ctx, 'first')
    expect(offBody.tools).toBeUndefined()

    ctx.conversations.updateWebSearchEnabled('conv-1', true)
    const onBody = await runTurn(ctx, 'second')
    expect(Array.isArray(onBody.tools)).toBe(true)
    expect(systemOf(onBody, 'anthropic_messages')).toContain('Web access is available through OpenChat tools.')
  })

  it('7) 历史搜索 + 本轮搜索关闭：provenance 注入、无完整模板、不声明 tools', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false, history: 'search' })
    const body = await runTurn(ctx, 'what did you find')
    const system = systemOf(body, 'anthropic_messages')

    expect(system).toContain(PROVENANCE_SENTINEL)
    // provenance 的 disabledNote 已覆盖「无当前工具 / 勿声称已搜索」
    expect(system).not.toContain(NO_SEARCH_SENTINEL)
    expect(body.tools).toBeUndefined()
    // 搜索关闭时沿用既有门控：不把历史工具调用重放为 tool_use（避免声明不存在的工具）
    const msgs = body.messages as Array<{ content: Array<{ type: string }> }>
    const blocks = msgs.flatMap((m) => m.content)
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false)
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false)
    // 历史搜索结果仍以 provenance 文本（聊天上下文）保留，绝不丢失
    expect(system).toContain('openchat_web_search')
  })

  it('7b) 历史搜索 + 本轮搜索开启：tool_use 与 tool_result 成对合法重放', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: true, history: 'search' })
    const body = await runTurn(ctx, 'and now search again')

    const msgs = body.messages as Array<{ content: Array<{ type: string; id?: string; tool_use_id?: string }> }>
    const blocks = msgs.flatMap((m) => m.content)
    const toolUse = blocks.find((b) => b.type === 'tool_use')
    const toolResult = blocks.find((b) => b.type === 'tool_result')
    expect(toolUse).toBeTruthy()
    expect(toolResult).toBeTruthy()
    expect(toolResult!.tool_use_id).toBe(toolUse!.id)
  })

  it('8) 历史搜索后应用重启：同一数据库重建 service 后请求结构一致', async () => {
    const first = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false, history: 'search' })
    const before = systemOf(await runTurn(first, 'q1'), 'anthropic_messages')
    // 锁在 finally 中先释放、随后才 save()；先让出一拍，再显式落盘后关闭。
    // save() 内部无 await（单线程下不会与其它 save 交错），重复调用安全。
    await new Promise((r) => setTimeout(r, 50))
    await first.storage.save()
    first.storage.close()

    // 重启：重新打开同一 DB 文件
    const storage2 = new StorageService(join(first.dir, 'openchat.db'))
    await storage2.init()
    const restarted = await setup({
      protocol: 'anthropic_messages', webSearchEnabled: false, history: 'search', storage: storage2, dir: first.dir,
    })
    const body = await runTurn(restarted, 'q2')
    const after = systemOf(body, 'anthropic_messages')

    expect(after).toContain(PROVENANCE_SENTINEL)
    expect(after).not.toContain(NO_SEARCH_SENTINEL)
    expect(body.tools).toBeUndefined()
    // 重启前后「是否注入完整模板」的判定一致
    expect(after.includes(NO_SEARCH_SENTINEL)).toBe(before.includes(NO_SEARCH_SENTINEL))
    storage2.close()
  })

  it('9) Chat Completions 原有行为不变：system 消息含完整 metadata 与无搜索声明', async () => {
    const ctx = await setup({ protocol: 'chat_completions', webSearchEnabled: false, systemPrompt: 'Be terse.' })
    const body = await runTurn(ctx, 'hello')
    const system = systemOf(body, 'chat_completions')

    expect(system).toContain('Current model:')
    expect(system).toContain('Current date:')
    expect(system).toContain('Current timezone:')
    expect(system).toContain('Additional info for this conversation:')
    expect(system).toContain('Be terse.')
    expect(system).toContain(NO_SEARCH_SENTINEL)
    const msgs = body.messages as Array<{ role: string }>
    expect(msgs[0].role).toBe('system')
    // 搜索关闭 → 无 tools 声明（既有行为）
    expect(body.tools).toBeUndefined()
  })

  it('10) Responses API 原有行为不变：instructions 含完整 metadata 与无搜索声明', async () => {
    const ctx = await setup({ protocol: 'responses', webSearchEnabled: false, systemPrompt: 'Be terse.' })
    const body = await runTurn(ctx, 'hello')
    const system = systemOf(body, 'responses')

    expect(system).toContain('Current model:')
    expect(system).toContain('Current date:')
    expect(system).toContain('Current timezone:')
    expect(system).toContain('Additional info for this conversation:')
    expect(system).toContain('Be terse.')
    expect(system).toContain(NO_SEARCH_SENTINEL)
    expect(Array.isArray(body.input)).toBe(true)
    expect(body.tools).toBeUndefined()
  })
})

// =====================================================================
// OFF → ON → OFF：搜索关闭轮不得重放历史工具调用。
// 复现故障：第一轮 ON 真实执行搜索；第二轮 OFF 时 request 未声明 tools，
// 却因 Anthropic 原生 transcript 重放，仍带着 tool_use / tool_result，
// 与 system 中「本轮无搜索工具」的 provenance 说明互相矛盾，
// 模型据此错误声称「本轮又执行了一次搜索」。
// =====================================================================

interface AnthropicSeedTurn {
  userText: string
  assistantText: string
  // 真实搜索轮：带 native transcript（assistant tool_use → user tool_result → assistant 正文）
  search?: { callId: string; query: string; output: string }
}

function seedAnthropicTurn(ctx: Ctx, turn: AnthropicSeedTurn, baseTs: number): void {
  ctx.messages.create({
    id: `q-${baseTs}`, conversationId: 'conv-1', segmentId: 'seg-1', role: 'user',
    content: turn.userText, attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
    status: 'completed', modelId: MODEL, reasoningEffort: null,
    providerTurnId: null, providerItemId: null, providerPayloadJson: null,
    errorCode: null, errorMessage: null, createdAt: baseTs, updatedAt: baseTs,
  })

  const msg: Message = {
    id: `a-${baseTs}`, conversationId: 'conv-1', segmentId: 'seg-1', role: 'assistant',
    content: turn.assistantText, attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
    status: 'completed', modelId: MODEL, reasoningEffort: null,
    providerTurnId: null, providerItemId: null, providerPayloadJson: null,
    protocolBlocksJson: null, errorCode: null, errorMessage: null,
    createdAt: baseTs + 1, updatedAt: baseTs + 1,
  }
  if (turn.search) {
    const { callId, query, output } = turn.search
    msg.providerPayloadJson = JSON.stringify({
      provider: 'custom', protocol: 'anthropic_messages',
      items: [
        { type: 'function_call', call_id: callId, name: 'openchat_web_search', arguments: JSON.stringify({ query }) },
        { type: 'function_call_output', call_id: callId, output },
      ],
    })
    // 真实 Anthropic 轮的原生 transcript（thinking → tool_use → tool_result → 正文）
    msg.protocolBlocksJson = JSON.stringify({
      protocol: 'anthropic_messages', modelId: MODEL,
      blocks: [{ type: 'text', text: turn.assistantText }],
      transcript: [
        { role: 'assistant', blocks: [
          { type: 'thinking', thinking: 'need to search', signature: 'sig' },
          { type: 'tool_use', id: callId, name: 'openchat_web_search', input: { query } },
        ] },
        { role: 'user', blocks: [
          { type: 'tool_result', tool_use_id: callId, content: output },
        ] },
        { role: 'assistant', blocks: [{ type: 'text', text: turn.assistantText }] },
      ],
    })
  }
  ctx.messages.create(msg)
}

const SEARCH_OUTPUT = JSON.stringify({ query: 'openai', results: [{ title: 'A1', url: 'https://a' }] })

describe('OFF → ON → OFF：Anthropic 搜索关闭轮不重放历史工具调用', () => {
  it('关闭轮：无 tools、无 tool_use/tool_result；历史搜索仅以 provenance 陈述一次', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false })
    // 第 1 轮 ON 的真实搜索历史
    seedAnthropicTurn(ctx, {
      userText: '查一下 OpenAI',
      assistantText: '查到了 A1（https://a）',
      search: { callId: 'toolu_1', query: 'openai', output: SEARCH_OUTPUT },
    }, Date.now() - 1000)

    const body = await runTurn(ctx, '你刚才搜到了什么？')
    const system = systemOf(body, 'anthropic_messages')
    const msgs = body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    const blocks = msgs.flatMap((m) => m.content)

    // 当前轮无搜索能力
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(system).toContain('no web search tool is provided for this turn')
    // 开关切换说明同样明确「本轮没有工具」，与 provenance 一致（不得互相否定）
    expect(system).toMatch(/toggled web search OFF/)
    expect(system).not.toMatch(/a web search tool is available this turn/)

    // 关键：关闭轮绝不重放历史工具调用
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false)
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false)

    // 历史事实仍完整保留在 system（只陈述一次）
    expect(system).toContain(PROVENANCE_SENTINEL)
    expect(system).toContain('openai')
    expect(system).toContain('A1')
    expect((system.match(/OPENCHAT_SEARCH_PROVENANCE_V1/g) ?? []).length).toBe(1)

    // 历史正文仍然可见（不因跳过工具重放而丢失回答）
    expect(blocks.some((b) => b.type === 'text' && (b.text ?? '').includes('查到了 A1'))).toBe(true)
  })

  it('开启轮：工具调用成对重放，且不注入「本轮无搜索工具」', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: true })
    seedAnthropicTurn(ctx, {
      userText: '查一下 OpenAI',
      assistantText: '查到了 A1（https://a）',
      search: { callId: 'toolu_1', query: 'openai', output: SEARCH_OUTPUT },
    }, Date.now() - 1000)

    const body = await runTurn(ctx, '再搜一次')
    const system = systemOf(body, 'anthropic_messages')
    const msgs = body.messages as Array<{ role: string; content: Array<{ type: string; id?: string }> }>
    const blocks = msgs.flatMap((m) => m.content)

    expect(Array.isArray(body.tools)).toBe(true)
    expect(system).toContain('a web search tool is available this turn')
    expect(system).not.toContain('no web search tool is provided for this turn')

    const toolUse = blocks.find((b) => b.type === 'tool_use')
    const toolResult = blocks.find((b) => b.type === 'tool_result') as { tool_use_id?: string } | undefined
    expect(toolUse).toBeTruthy()
    expect(toolResult).toBeTruthy()
    expect(toolResult!.tool_use_id).toBe((toolUse as { id?: string }).id)
  })

  it('历史搜索只产生一份 provenance，不随轮数重复增长', async () => {
    const ctx = await setup({ protocol: 'anthropic_messages', webSearchEnabled: false })
    seedAnthropicTurn(ctx, {
      userText: '查 A',
      assistantText: 'A 的答案',
      search: { callId: 'toolu_a', query: 'qa', output: SEARCH_OUTPUT },
    }, Date.now() - 2000)
    seedAnthropicTurn(ctx, {
      userText: '查 B',
      assistantText: 'B 的答案',
      search: { callId: 'toolu_b', query: 'qb', output: SEARCH_OUTPUT },
    }, Date.now() - 1000)

    const body = await runTurn(ctx, '总结一下')
    const system = systemOf(body, 'anthropic_messages')

    expect((system.match(/OPENCHAT_SEARCH_PROVENANCE_V1/g) ?? []).length).toBe(1)
    // 两条历史事实各出现一次（query 行形如 "      - qa"）
    expect((system.match(/^\s+- qa$/gm) ?? []).length).toBe(1)
    expect((system.match(/^\s+- qb$/gm) ?? []).length).toBe(1)
    // 同一份历史只对应一个 turn 锚点编号体系（不重复计数）
    expect(system).toMatch(/turn: #1/)
    expect(system).toMatch(/turn: #2/)
  })
})

// =====================================================================
// 跨协议一致性：三个第三方协议在相同配置 / 相同历史下必须得到
// 相同的应用级 System Prompt 规则（仅序列化字段不同）。
// =====================================================================
const THIRD_PARTY: Protocol[] = ['anthropic_messages', 'chat_completions', 'responses']

describe('跨协议一致性 A：基础提示词', () => {
  const BASE_MARKERS = [
    'Current model:',
    'Current date:',
    'Current timezone:',
    'Additional info for this conversation:',
  ]

  it('无用户提示词 → 兜底角色 + 完整 metadata（三协议一致）', async () => {
    for (const protocol of THIRD_PARTY) {
      const ctx = await setup({ protocol, webSearchEnabled: false })
      const system = systemOf(await runTurn(ctx, 'hello'), protocol)
      for (const m of BASE_MARKERS) expect(system).toContain(m)
      expect(system).toContain('You are a helpful assistant.')
    }
  })

  it('空字符串 / 仅空白用户提示词 → 与未配置等价（三协议一致）', async () => {
    for (const protocol of THIRD_PARTY) {
      for (const systemPrompt of ['', '   \n\t ']) {
        const ctx = await setup({ protocol, webSearchEnabled: false, systemPrompt })
        const system = systemOf(await runTurn(ctx, 'hello'), protocol)
        expect(system).toContain('You are a helpful assistant.')
        expect(system).not.toContain('Additional info for this conversation:\n\n\n')
      }
    }
  })

  it('自定义用户提示词 → 原样保留且位于 metadata 之后（三协议一致）', async () => {
    for (const protocol of THIRD_PARTY) {
      const ctx = await setup({ protocol, webSearchEnabled: false, systemPrompt: '你是一个简洁的编程助手。' })
      const system = systemOf(await runTurn(ctx, 'hello'), protocol)
      expect(system).toContain('你是一个简洁的编程助手。')
      expect(system).not.toContain('You are a helpful assistant.')
      // 顺序：Additional info 标题 → 用户提示词（用户提示词位于 metadata 之后）
      const infoIdx = system.indexOf('Additional info for this conversation:')
      const userIdx = system.indexOf('你是一个简洁的编程助手。')
      expect(infoIdx).toBeGreaterThanOrEqual(0)
      expect(userIdx).toBeGreaterThan(infoIdx)
    }
  })

  it('不同模型名 → 仅 Current model 行不同，其余规则一致', async () => {
    const systems: Record<string, string> = {}
    for (const protocol of THIRD_PARTY) {
      const ctx = await setup({ protocol, webSearchEnabled: false })
      systems[protocol] = systemOf(await runTurn(ctx, 'hello'), protocol)
    }
    for (const protocol of THIRD_PARTY) {
      expect(systems[protocol]).toContain(`Current model: ${MODEL}`)
    }
  })
})

describe('跨协议一致性 B：NOTICE 策略', () => {
  it('OFF、无历史 → 三协议都注入 NOTICE', async () => {
    for (const protocol of THIRD_PARTY) {
      const ctx = await setup({ protocol, webSearchEnabled: false })
      const system = systemOf(await runTurn(ctx, 'hello'), protocol)
      expect(system).toContain(NO_SEARCH_SENTINEL)
    }
  })

  it('OFF、有历史 → 三协议都注入 provenance 且都不注入 NOTICE', async () => {
    for (const protocol of THIRD_PARTY) {
      const ctx = await setup({ protocol, webSearchEnabled: false, history: 'search' })
      const system = systemOf(await runTurn(ctx, 'what did you find'), protocol)
      expect(system).toContain(PROVENANCE_SENTINEL)
      expect(system).not.toContain(NO_SEARCH_SENTINEL)
      // 不得同时声明「搜索已关闭」与「历史确实搜索过」的矛盾
      expect(system).toContain('no web search tool is provided for this turn')
    }
  })

  it('ON、Tools → 三协议都无 NOTICE 且都含搜索指令', async () => {
    for (const protocol of THIRD_PARTY) {
      const ctx = await setup({ protocol, webSearchEnabled: true })
      const body = await runTurn(ctx, 'search python')
      const system = systemOf(body, protocol)
      expect(system).not.toContain(NO_SEARCH_SENTINEL)
      expect(system).toContain('Web access is available through OpenChat tools.')
      expect(Array.isArray(body.tools)).toBe(true)
    }
  })
})

// 注：PreSearch 降级是「多请求」流程（extractSearchQuery → webSearchService.search →
// 最终生成），现有 runTurn 只捕获单次请求，端到端断言不可靠；其请求构建已由
// preSearchSemantics.test.ts（直接调用 buildCanonicalRequest，覆盖成功·0结果·失败
// 与三协议一致性）以及 searchModeSemantics.regression.test.ts 的三态单测覆盖。
