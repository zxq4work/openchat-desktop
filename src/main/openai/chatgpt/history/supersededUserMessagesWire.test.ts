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

vi.mock('../httpsClient', () => ({
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

import { StorageService } from '../../../storage/StorageService'
import { ConversationRepository } from '../../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../../storage/MessageRepository'
import { AttachmentRepository } from '../../../storage/AttachmentRepository'
import { AttachmentService } from '../../../services/attachments/AttachmentService'
import { ChatGPTConversationService } from '../ChatGPTConversationService'
import { RealChatGPTCodexClient } from '../transport/ChatGPTCodexClient'
import { AnthropicMessagesAdapter } from '../../../providers/anthropic/AnthropicMessagesAdapter'
import { ChatCompletionsAdapter } from '../../../providers/ChatCompletionsAdapter'
import { ResponsesAdapter } from '../../../providers/ResponsesAdapter'
import type { Conversation, ContextSegment, Message, MessageStatus, MessageAttachment } from '../../../../shared/types/conversation'
import type { ModelAdapter } from '../../../../shared/types/provider'

// =====================================================================
// 失败重试去重 — 断言「最终 HTTP 请求的实际消息序列」（三协议一致）。
//
// 复现故障：搜索轮 HTTP 504 → assistant=failed → 用户重发相同消息 →
// 历史出现两条连续且内容相同的 user，模型据此否认上一轮真实搜索。
//
// 约束：只删「failed assistant + 等价重发」这一结构性证据下的旧 user；
// 其余（不同文本 / 正常连续 / 两次都成功 / 带附件不同）一律保留。
// =====================================================================

type Protocol = 'anthropic_messages' | 'chat_completions' | 'responses'

const MODEL = 'test-model'
const PROVIDER_ID = 'prov-1'

function makeAdapter(protocol: Protocol, imageInput = false): ModelAdapter {
  if (protocol === 'anthropic_messages') {
    return new AnthropicMessagesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true, imageInput })
  }
  if (protocol === 'responses') {
    return new ResponsesAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true, imageInput })
  }
  return new ChatCompletionsAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true, imageInput })
}

interface Ctx {
  service: ChatGPTConversationService
  storage: StorageService
  messages: MessageRepository
  protocol: Protocol
  dir: string
  attachmentService: AttachmentService
}

async function setup(protocol: Protocol, webSearchEnabled: boolean, opts: { imageInput?: boolean } = {}): Promise<Ctx> {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-superseded-'))
  const storage = new StorageService(join(dir, 'openchat.db'))
  await storage.init()

  const conversations = new ConversationRepository(storage)
  const segments = new ContextSegmentRepository(storage)
  const messages = new MessageRepository(storage)
  const now = Date.now()

  const conversation: Conversation = {
    id: 'conv-1', type: 'chat', title: 't', systemPrompt: '', systemPromptRevision: 0,
    defaultModelId: MODEL, defaultReasoningEffort: null, currentSegmentId: 'seg-1',
    useModelInstructions: false, webSearchEnabled, codexSearchMode: 'hosted', searchEngine: 'bing',
    providerConfigId: PROVIDER_ID,
    defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
    providerNameSnapshot: null, modelNameSnapshot: null,
    requestParameterValues: {}, createdAt: now, updatedAt: now,
  }
  conversations.create(conversation)
  const segment: ContextSegment = {
    id: 'seg-1', conversationId: 'conv-1', sequence: 1, reason: 'conversation-created',
    providerThreadId: null, systemPromptRevision: 0, systemPromptSnapshot: '', createdAt: now,
  }
  segments.create(segment)

  const adapter = makeAdapter(protocol, opts.imageInput === true)
  const credentialManager = { getAccessToken: async () => 'tok', getAccountId: async () => 'acc' } as never
  const codexClient = new RealChatGPTCodexClient(credentialManager)
  const modelService = {
    currentModels: [{ id: MODEL, supportedReasoningEfforts: [], inputModalities: ['text', 'image'] }],
    getModelInfo: () => undefined,
    getInstructionsTemplate: () => null,
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
    listSafe: () => [{ id: PROVIDER_ID, name: 'P', protocol, models: [MODEL] }],
    getAdapter: () => adapter,
    getBaseUrl: () => 'https://api.example',
    getResolvedRequestParameters: () => [],
  } as never

  const service = new ChatGPTConversationService(
    storage, codexClient, modelService as never, credentialManager, usageService as never,
    toolRegistry as never, webSearchService as never, providerConfigService as never,
    undefined, false // readHistoryToolEnabled=false → 请求体只含搜索工具
  )

  // 图片附件场景：真实落盘 + DB 记录，供 Adapter 编码时读取字节。
  const attachmentService = new AttachmentService(join(dir, 'attachments'), new AttachmentRepository(storage))
  service.setAttachmentService(attachmentService)

  return { service, storage, messages, protocol, dir, attachmentService }
}

let seq = 1000
function seed(
  messages: MessageRepository,
  role: 'user' | 'assistant',
  content: string,
  over: Partial<Message> = {}
): Message {
  seq++
  const msg: Message = {
    id: `m-${seq}`, conversationId: 'conv-1', segmentId: 'seg-1', role, content,
    attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
    webSearchResults: null, webSearchError: null,
    status: 'completed' as MessageStatus,
    modelId: MODEL, reasoningEffort: null, providerTurnId: null, providerItemId: null,
    providerPayloadJson: null, errorCode: null, errorMessage: null,
    createdAt: seq, updatedAt: seq, ...over,
  }
  messages.create(msg)
  return msg
}

const sse = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const ANTHROPIC_OK =
  sse('message_start', { type: 'message_start', message: { id: 'm1', model: MODEL, usage: {} } }) +
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
  sse('message_stop', { type: 'message_stop' })

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
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

async function sendAndCapture(ctx: Ctx, text: string): Promise<Record<string, unknown>> {
  net.lastRequest = null
  void ctx.service.sendMessage('conv-1', text).catch(() => { /* 只关心请求体 */ })
  await waitFor(() => net.lastRequest !== null && net.lastRequest.body.length > 0)
  const rec = net.lastRequest!
  const parsed = JSON.parse(rec.body) as Record<string, unknown>

  await respondAndReady(rec)
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
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    ))
  }
  rec.res.emit('end')
  await waitFor(() => activeLock(ctx.service) === null, 4000)
  await new Promise((r) => setTimeout(r, 5))
  return parsed
}

// 从最终请求体提取「普通 user 消息的文本序列」（协议无关）。
// 注意：Anthropic / 部分协议的 tool_result 也是 role=user，但只含 tool_result 块、无文本块，
// 必须排除，否则会被误计成一条空 user 消息。
function userTexts(body: Record<string, unknown>, protocol: Protocol): string[] {
  if (protocol === 'anthropic_messages' || protocol === 'chat_completions') {
    const msgs = body.messages as Array<{ role: string; content: unknown }>
    const out: string[] = []
    for (const m of msgs) {
      if (m.role !== 'user') continue
      const c = m.content
      if (typeof c === 'string') { out.push(c); continue }
      if (!Array.isArray(c)) continue
      // 纯 tool_result 的 user 消息（无文本块）不计入用户正文序列。
      const textPart = (c as Array<Record<string, unknown>>).find((p) => p.type === 'text' || p.type === 'input_text')
      if (textPart && typeof textPart.text === 'string') out.push(textPart.text)
    }
    return out
  }
  // responses: body.input 数组
  const input = body.input as Array<Record<string, unknown>>
  return input
    .filter((it) => it.type === 'message' && it.role === 'user')
    .map((it) => {
      const content = it.content as Array<Record<string, unknown>>
      const textPart = content.find((p) => p.type === 'input_text' || p.type === 'text')
      return typeof textPart?.text === 'string' ? textPart.text : ''
    })
}

const PROTOCOLS: Protocol[] = ['chat_completions', 'responses', 'anthropic_messages']
const PROVENANCE_SENTINEL = 'OPENCHAT_SEARCH_PROVENANCE_V1'

function systemOf(body: Record<string, unknown>, protocol: Protocol): string {
  if (protocol === 'anthropic_messages') return typeof body.system === 'string' ? body.system : ''
  if (protocol === 'responses') return typeof body.instructions === 'string' ? body.instructions : ''
  const msgs = body.messages as Array<{ role: string; content: unknown }>
  const sys = msgs.find((m) => m.role === 'system')
  return sys ? String(sys.content) : ''
}

beforeEach(() => { net.lastRequest = null })

// 真实写入一张 PNG 原图并建立 attachment DB 记录（不依赖 nativeImage 解码）。
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
function seedImageAttachment(ctx: Ctx, id: string, sha256: string): MessageAttachment {
  const dir = join(ctx.dir, 'attachments', 'originals')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, `${id}.png`), PNG_BYTES)
  const att: MessageAttachment = {
    id, messageId: null, conversationId: null, segmentId: null, type: 'image',
    mimeType: 'image/png', fileName: `${id}.png`, fileSize: PNG_BYTES.length,
    width: 1, height: 1, detail: 'auto', sha256, source: 'user_upload', usage: 'chat_input',
    createdAt: Date.now(),
  }
  new AttachmentRepository(ctx.storage).create(att)
  return att
}

// =====================================================================
// 场景 1：HTTP 504 后发送相同消息 → 最终请求不包含被取代的重复 user。
// =====================================================================
describe('场景 1：失败重试（相同文本）', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: 失败轮 user 被跳过，成功轮 + 当前轮保留，DB 历史不变`, async () => {
      const ctx = await setup(protocol, false)
      // User A + Assistant A(failed：HTTP 504)
      const userA = seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '', { status: 'failed', errorCode: 'StreamFailed', errorMessage: 'HTTP 504' })
      // User B + Assistant B(completed，真实搜索成功)
      seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '已搜索到 Python 官网', {
        webSearchResults: [{ title: 'Welcome to Python.org', url: 'https://www.python.org/', snippet: null }],
        providerPayloadJson: JSON.stringify({
          provider: 'custom', protocol: 'chat_completions',
          items: [
            { type: 'function_call', call_id: 'c-ok', name: 'openchat_web_search', arguments: '{"query":"python official"}' },
            { type: 'function_call_output', call_id: 'c-ok', output: JSON.stringify({ query: 'python official', results: [{ title: 'Welcome to Python.org', url: 'https://www.python.org/' }] }) },
          ],
        }),
      })
      // User C：关闭搜索后询问（本轮）
      const body = await sendAndCapture(ctx, '上一轮是否真的搜索了？')

      const users = userTexts(body, protocol)
      // 失败轮 User A 被取代 → 只剩「搜索 Python 官网」（B）+ 当前「上一轮…」
      expect(users).toEqual(['搜索 Python 官网', '上一轮是否真的搜索了？'])
      expect(users.filter((u) => u === '搜索 Python 官网')).toHaveLength(1)

      // 搜索 provenance 仍在（成功轮的事实未丢失）
      const sys = systemOf(body, protocol)
      expect(sys).toContain(PROVENANCE_SENTINEL)
      expect(sys).toContain('https://www.python.org/')

      // 历史失败事实：模型能正确获知真实 504 与重发成功
      expect(sys).toContain('OPENCHAT_HISTORY_FAILURES_V1')
      expect(sys).toContain('A previous assistant generation failed.')
      expect(sys).toContain('HTTP status: 504')
      expect(sys).toMatch(/resent an equivalent request/i)
      expect(sys).toMatch(/replacement assistant generation completed successfully/i)
      // 独立于搜索：搜索次数仍为 1（失败轮不计入成功搜索）
      expect(sys).toMatch(/results returned: 1/)

      // 数据库历史不变：失败轮 User A 与 failed assistant 仍在
      expect(ctx.messages.getById(userA.id)).not.toBeNull()
      const segMsgs = ctx.messages.getBySegmentId('seg-1')
      expect(segMsgs.filter((m) => m.role === 'user' && m.content === '搜索 Python 官网')).toHaveLength(2)
      expect(segMsgs.some((m) => m.role === 'assistant' && m.status === 'failed')).toBe(true)
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 场景 2：失败后发送不同文本 → 不得误删有效 user。
// =====================================================================
describe('场景 2：失败后发送不同问题', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: 语义不同 → 两条 user 均保留`, async () => {
      const ctx = await setup(protocol, false)
      seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '', { status: 'failed', errorCode: 'StreamFailed', errorMessage: 'HTTP 504' })
      seed(ctx.messages, 'user', '解释 HTTP 504')

      const body = await sendAndCapture(ctx, '继续解释')
      const users = userTexts(body, protocol)
      expect(users).toEqual(['搜索 Python 官网', '解释 HTTP 504', '继续解释'])
      // 失败事实存在（504），但不得声明「等价重发」（两条 user 语义不同）
      const sys = systemOf(body, protocol)
      expect(sys).toContain('HTTP status: 504')
      expect(sys).not.toMatch(/resent an equivalent request/i)
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 场景 3：正常连续发送 user → 全部保留。
// =====================================================================
describe('场景 3：正常连续 user 消息', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: 连续 user（中间无 failed assistant）全部保留`, async () => {
      const ctx = await setup(protocol, false)
      seed(ctx.messages, 'user', '第一条信息')
      seed(ctx.messages, 'user', '第二条信息')

      const body = await sendAndCapture(ctx, '第三条信息')
      const users = userTexts(body, protocol)
      expect(users).toEqual(['第一条信息', '第二条信息', '第三条信息'])
      // 无失败记录 → 不注入失败事实块
      expect(systemOf(body, protocol)).not.toContain('OPENCHAT_HISTORY_FAILURES_V1')
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 场景 4：两次相同文本但都成功 → 全部保留。
// =====================================================================
describe('场景 4：相同文本都成功', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: assistant completed → 不删除任何 user`, async () => {
      const ctx = await setup(protocol, false)
      seed(ctx.messages, 'user', '你好')
      seed(ctx.messages, 'assistant', '你好！')
      seed(ctx.messages, 'user', '你好')
      seed(ctx.messages, 'assistant', '又见面了')

      const body = await sendAndCapture(ctx, '你好')
      const users = userTexts(body, protocol)
      expect(users).toEqual(['你好', '你好', '你好'])
      // 两次都成功 → 无失败事实（不得生成虚假失败记录）
      expect(systemOf(body, protocol)).not.toContain('OPENCHAT_HISTORY_FAILURES_V1')
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 场景：状态区分 — stopped / pending / streaming 不视为失败重试。
// =====================================================================
describe('状态区分：仅 failed 触发取代', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: assistant=stopped + 相同文本 → 全部保留`, async () => {
      const ctx = await setup(protocol, false)
      seed(ctx.messages, 'user', '搜索一下')
      seed(ctx.messages, 'assistant', '', { status: 'stopped' })
      seed(ctx.messages, 'user', '搜索一下')

      const body = await sendAndCapture(ctx, '继续')
      const users = userTexts(body, protocol)
      expect(users).toEqual(['搜索一下', '搜索一下', '继续'])
      // stopped 不是失败 → 不生成失败记录
      expect(systemOf(body, protocol)).not.toContain('OPENCHAT_HISTORY_FAILURES_V1')
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 场景 8：Search ON — 原生工具历史恢复，且失败轮 user 仍被去重。
// =====================================================================
describe('Search ON：原生工具历史恢复 + 失败轮去重', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: tools 声明存在，成功轮原生工具历史重放，失败轮 user 被跳过`, async () => {
      const ctx = await setup(protocol, true)
      seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '', { status: 'failed', errorCode: 'StreamFailed', errorMessage: 'HTTP 504' })
      seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '已搜索到 Python 官网', {
        providerPayloadJson: JSON.stringify({
          provider: 'custom', protocol,
          items: [
            { type: 'function_call', call_id: 'c-ok', name: 'openchat_web_search', arguments: '{"query":"python official"}' },
            { type: 'function_call_output', call_id: 'c-ok', output: JSON.stringify({ query: 'python official', results: [{ title: 'Welcome to Python.org', url: 'https://www.python.org/' }] }) },
          ],
        }),
      })

      const body = await sendAndCapture(ctx, '再搜索一次')
      const users = userTexts(body, protocol)
      // 失败轮 user 去重；成功轮 user + 当前轮保留
      expect(users.filter((u) => u === '搜索 Python 官网')).toHaveLength(1)
      expect(users).toContain('再搜索一次')
      // tools 声明存在（Search ON）
      expect(Array.isArray(body.tools)).toBe(true)
      // 原生工具历史重放：历史 call id 'c-ok' 只能来自重放（工具定义里没有），
      // 证明成功轮的真实工具调用确实进入了 wire（三协议各自序列化）。
      expect(JSON.stringify(body)).toContain('c-ok')
      // 失败事实在 Search ON 时同样出现（且区分「模型接口失败」而非「搜索工具失败」）
      const sys = systemOf(body, protocol)
      expect(sys).toContain('HTTP status: 504')
      expect(sys).toMatch(/NOT web-search tool failures/i)
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 失败记录真实性：failed 但无 HTTP 状态码 → unknown，绝不猜 504。
// =====================================================================
describe('历史失败事实：无状态码时不得猜测 504', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: failed 无 HTTP 状态码 → unknown，且旧 user 仍被去重`, async () => {
      const ctx = await setup(protocol, false)
      seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '', { status: 'failed', errorCode: 'StreamFailed', errorMessage: 'socket hang up' })
      seed(ctx.messages, 'user', '搜索 Python 官网')
      seed(ctx.messages, 'assistant', '已完成')

      const body = await sendAndCapture(ctx, '上一轮发生了什么？')
      const users = userTexts(body, protocol)
      // 等价重发 → 旧 user 仍被过滤
      expect(users.filter((u) => u === '搜索 Python 官网')).toHaveLength(1)
      const sys = systemOf(body, protocol)
      expect(sys).toContain('HTTP status: unknown')
      expect(sys).not.toContain('HTTP status: 504')
      ctx.storage.close()
    })
  }
})

// =====================================================================
// 重发后 replacement assistant 状态：pending/streaming 不得被判为失败。
// =====================================================================
describe('失败重发：replacement 未完成时不得描述为失败', () => {
  for (const protocol of PROTOCOLS) {
    for (const status of ['pending', 'streaming'] as MessageStatus[]) {
      it(`${protocol}: replacement status=${status} → not yet confirmed complete`, async () => {
        const ctx = await setup(protocol, false)
        seed(ctx.messages, 'user', '搜索 Python 官网')
        seed(ctx.messages, 'assistant', '', { status: 'failed', errorCode: 'StreamFailed', errorMessage: 'HTTP 504: x' })
        seed(ctx.messages, 'user', '搜索 Python 官网')
        seed(ctx.messages, 'assistant', '', { status })

        const body = await sendAndCapture(ctx, '继续')
        const sys = systemOf(body, protocol)
        expect(sys).toContain('HTTP status: 504')
        expect(sys).toMatch(/resent an equivalent request/i)
        expect(sys).toMatch(/not yet confirmed complete/i)
        expect(sys).not.toMatch(/did NOT complete successfully/i)
        expect(sys).not.toMatch(/replacement assistant generation failed/i)
        ctx.storage.close()
      })
    }
  }
})

// =====================================================================
// 场景 9：携带附件的消息 — 文本相同但附件不同，不得合并。
// =====================================================================
describe('附件参与等价性：文本相同但附件不同 → 不误删', () => {
  for (const protocol of PROTOCOLS) {
    it(`${protocol}: 两条「看图」附件 sha256 不同 → 两条 user 都保留`, async () => {
      const ctx = await setup(protocol, false, { imageInput: true })
      seedImageAttachment(ctx, 'att-A', 'aaaa')
      seedImageAttachment(ctx, 'att-B', 'bbbb')
      const userA = seed(ctx.messages, 'user', '看图')
      seed(ctx.messages, 'assistant', '', { status: 'failed', errorCode: 'StreamFailed', errorMessage: 'HTTP 504' })
      const userB = seed(ctx.messages, 'user', '看图')
      // 附件归属权威来源是 message_attachments（MessageRepository 读取时挂载），
      // 因此必须把草稿附件绑定到对应 message。
      const attachments = new AttachmentRepository(ctx.storage)
      attachments.bindToMessage('att-A', userA.id, 'conv-1', 'seg-1')
      attachments.bindToMessage('att-B', userB.id, 'conv-1', 'seg-1')

      const body = await sendAndCapture(ctx, '继续')
      const users = userTexts(body, protocol)
      // 附件不同 → 不等价 → 不删除任何历史 user
      expect(users).toEqual(['看图', '看图', '继续'])
      // 两张图片确实作为图片内容进入请求（证明不是被误判成纯文本合并）
      expect(JSON.stringify(body)).toContain('image')
      ctx.storage.close()
    })
  }
})