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
import { ChatGPTConversationService } from '../ChatGPTConversationService'
import { RealChatGPTCodexClient } from '../transport/ChatGPTCodexClient'
import { ChatCompletionsAdapter } from '../../../providers/ChatCompletionsAdapter'
import type { Conversation, ContextSegment, Message } from '../../../../shared/types/conversation'

// =====================================================================
// 六轮 OFF→ON→OFF→ON→OFF→ON 的**最终 HTTP 请求**断言（chat_completions）。
//
// 复现实测故障：第 3、5 轮（OFF）模型否认上一轮真实搜索。
// 这里断言「发给模型的内容」是否足以支撑正确判断：
//   - system 中是否有准确的历史搜索事实（轮次 / 提问 / 结果 / 来源）；
//   - 是否同时存在互相冲突的 NO_SEARCH_CAPABILITY_NOTICE；
//   - tools 声明与当前搜索状态一致。
//
// 说明：本文件是**请求结构测试**，不验证模型最终自然语言结论。
// =====================================================================

const MODEL = 'deepseek-v4-pro'
const PROVIDER_ID = 'prov-1'

async function setup(webSearchEnabled: boolean) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-provwire-'))
  const storage = new StorageService(join(dir, 'openchat.db'))
  await storage.init()

  const conversations = new ConversationRepository(storage)
  const segments = new ContextSegmentRepository(storage)
  const messages = new MessageRepository(storage)
  const now = Date.now()

  conversations.create({
    id: 'conv-1', type: 'chat', title: 't', systemPrompt: '', systemPromptRevision: 0,
    defaultModelId: MODEL, defaultReasoningEffort: null, currentSegmentId: 'seg-1',
    useModelInstructions: false, webSearchEnabled, codexSearchMode: 'hosted', searchEngine: 'bing',
    providerConfigId: PROVIDER_ID,
    defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
    providerNameSnapshot: null, modelNameSnapshot: null,
    requestParameterValues: {}, createdAt: now, updatedAt: now,
  } satisfies Conversation)
  segments.create({
    id: 'seg-1', conversationId: 'conv-1', sequence: 1, reason: 'conversation-created',
    providerThreadId: null, systemPromptRevision: 0, systemPromptSnapshot: '', createdAt: now,
  } satisfies ContextSegment)

  const adapter = new ChatCompletionsAdapter({ baseUrl: 'https://api.example', apiKey: 'k', toolCalling: true })
  const credentialManager = { getAccessToken: async () => 'tok', getAccountId: async () => 'acc' } as never
  const modelService = {
    currentModels: [{ id: MODEL, supportedReasoningEfforts: [] }],
    getModelInfo: () => undefined,
    getInstructionsTemplate: () => null,
    resolveEffort: () => null,
  } as never
  const toolRegistry = {
    getDefinitions: () => [{ name: 'openchat_web_search', description: '', parameters: { type: 'object', properties: {} } }],
    getExecutor: (name: string) => name === 'openchat_web_search'
      ? { definition: { name, description: '', parameters: {} }, execute: async () => ({ callId: '', name, output: '' }) }
      : undefined,
    has: () => true,
  } as never

  const service = new ChatGPTConversationService(
    storage,
    new RealChatGPTCodexClient(credentialManager),
    modelService, credentialManager,
    { getState: () => ({ state: 'ok' }), refresh: async () => {}, markExhaustedFrom429: () => {} } as never,
    toolRegistry,
    { getEngineName: () => 'bing', setEngine: () => {}, search: async () => [], setMaxResults: () => {} } as never,
    {
      listSafe: () => [{ id: PROVIDER_ID, name: 'P', protocol: 'chat_completions', models: [MODEL] }],
      getAdapter: () => adapter,
      getBaseUrl: () => 'https://api.example',
      getResolvedRequestParameters: () => [],
    } as never,
    undefined, false
  )

  return { service, storage, conversations, messages, dir }
}

let seq = 0
function seedUser(messages: MessageRepository, content: string): void {
  seq++
  messages.create({
    id: `u-${seq}`, conversationId: 'conv-1', segmentId: 'seg-1', role: 'user',
    content, attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
    status: 'completed', modelId: MODEL, reasoningEffort: null,
    providerTurnId: null, providerItemId: null, providerPayloadJson: null,
    errorCode: null, errorMessage: null, createdAt: seq, updatedAt: seq,
  })
}

function seedSearchAssistant(
  messages: MessageRepository,
  query: string,
  results: Array<{ title: string; url: string }>,
  answer: string
): void {
  seq++
  const callId = `call-${seq}`
  messages.create({
    id: `a-${seq}`, conversationId: 'conv-1', segmentId: 'seg-1', role: 'assistant',
    content: answer, attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none',
    webSearchResults: results.map((r) => ({ title: r.title, url: r.url, snippet: null })),
    webSearchError: null,
    status: 'completed', modelId: MODEL, reasoningEffort: null,
    providerTurnId: null, providerItemId: null,
    providerPayloadJson: JSON.stringify({
      provider: 'custom', protocol: 'chat_completions',
      items: [
        { type: 'function_call', call_id: callId, name: 'openchat_web_search', arguments: JSON.stringify({ query }) },
        { type: 'function_call_output', call_id: callId, output: JSON.stringify({ query, results }) },
      ],
    }),
    errorCode: null, errorMessage: null, createdAt: seq, updatedAt: seq,
  })
}

function seedPlainAssistant(messages: MessageRepository, answer: string): void {
  seq++
  messages.create({
    id: `a-${seq}`, conversationId: 'conv-1', segmentId: 'seg-1', role: 'assistant',
    content: answer, attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
    status: 'completed', modelId: MODEL, reasoningEffort: null,
    providerTurnId: null, providerItemId: null, providerPayloadJson: null,
    errorCode: null, errorMessage: null, createdAt: seq, updatedAt: seq,
  })
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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

async function sendAndCapture(service: ChatGPTConversationService, text: string): Promise<Record<string, unknown>> {
  net.lastRequest = null
  void service.sendMessage('conv-1', text).catch(() => { /* 只关心请求体 */ })
  await waitFor(() => net.lastRequest !== null && net.lastRequest.body.length > 0)
  const rec = net.lastRequest!
  const parsed = JSON.parse(rec.body) as Record<string, unknown>

  const ready = new Promise<void>((resolve) => {
    const orig = rec.res.on.bind(rec.res)
    ;(rec.res as unknown as { on: unknown }).on = ((ev: string, fn: (...a: unknown[]) => void) => {
      const ret = orig(ev, fn)
      if (ev === 'data') resolve()
      return ret
    }) as typeof rec.res.on
  })
  rec.respond()
  await ready
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  rec.res.emit('data', Buffer.from(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  ))
  rec.res.emit('end')
  await waitFor(() => activeLock(service) === null, 3000)
  await new Promise((r) => setTimeout(r, 5))
  return parsed
}

function systemOf(body: Record<string, unknown>): string {
  const msgs = body.messages as Array<{ role: string; content: unknown }>
  const sys = msgs.find((m) => m.role === 'system')
  return sys ? String(sys.content) : ''
}

const NO_SEARCH_SENTINEL = 'You do not have web search tools available'
const PROVENANCE_SENTINEL = 'OPENCHAT_SEARCH_PROVENANCE_V1'

beforeEach(() => { net.lastRequest = null })

describe('第 3 轮（OFF）：询问上一轮搜索的历史结果', () => {
  it('最终 system 含准确历史事实，且不与 NO_SEARCH_CAPABILITY_NOTICE 冲突', async () => {
    const ctx = await setup(false)
    // 第 1 轮 OFF
    seedUser(ctx.messages, '你好')
    seedPlainAssistant(ctx.messages, '你好！')
    // 第 2 轮 ON：搜索 A
    seedUser(ctx.messages, 'OpenAI 最新消息')
    seedSearchAssistant(ctx.messages, 'openai news', [{ title: 'A1', url: 'https://a' }], '查到 A1')

    const body = await sendAndCapture(ctx.service, '你刚才搜到了什么？')
    const system = systemOf(body)

    // 历史事实完整：哪一轮、用户问了什么、查了什么、返回几条、来源
    expect(system).toContain(PROVENANCE_SENTINEL)
    expect(system).toMatch(/turn: #2/)
    expect(system).toContain('user asked: OpenAI 最新消息')
    expect(system).toContain('openai news')
    expect(system).toMatch(/results returned: 1/)
    expect(system).toContain('A1')
    expect(system).toContain('https://a')
    // 当前能力单独、无冲突地陈述
    expect(system).toContain('no web search tool is provided for this turn')
    expect(system).not.toContain(NO_SEARCH_SENTINEL)
    // 本轮无工具
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    ctx.storage.close()
  })
})

describe('第 5 轮（OFF）：总结 A 与 B 两条历史搜索', () => {
  it('最终 system 同时呈现 A/B 两条事实，各自带轮次与结果', async () => {
    const ctx = await setup(false)
    seedUser(ctx.messages, '你好')
    seedPlainAssistant(ctx.messages, '你好！')
    seedUser(ctx.messages, '查 A')
    seedSearchAssistant(ctx.messages, 'query A', [{ title: 'A1', url: 'https://a' }], '答 A')
    seedUser(ctx.messages, 'A 的结果是什么')
    seedPlainAssistant(ctx.messages, 'A1')
    seedUser(ctx.messages, '查 B')
    seedSearchAssistant(ctx.messages, 'query B', [{ title: 'B1', url: 'https://b' }], '答 B')

    const body = await sendAndCapture(ctx.service, '总结一下 A 和 B')
    const system = systemOf(body)

    expect(system).toContain(PROVENANCE_SENTINEL)
    expect(system).toContain('query A')
    expect(system).toContain('query B')
    expect(system).toContain('A1')
    expect(system).toContain('B1')
    // 两个不同轮次锚点
    expect(system).toMatch(/turn: #2/)
    expect(system).toMatch(/turn: #4/)
    // 关闭态陈述 + 无冲突模板
    expect(system).toContain('no web search tool is provided for this turn')
    expect(system).not.toContain(NO_SEARCH_SENTINEL)
    expect(body.tools).toBeUndefined()
    ctx.storage.close()
  })
})

describe('第 6 轮（ON）：重新执行新搜索', () => {
  it('tools 声明恢复、搜索指令存在，历史事实仍标注为过去轮', async () => {
    const ctx = await setup(true)
    seedUser(ctx.messages, '查 A')
    seedSearchAssistant(ctx.messages, 'query A', [{ title: 'A1', url: 'https://a' }], '答 A')

    const body = await sendAndCapture(ctx.service, '再帮我搜一下 C')
    const system = systemOf(body)

    expect(Array.isArray(body.tools)).toBe(true)
    expect(body.tool_choice).toBe('auto')
    expect(system).toContain('Web access is available through OpenChat tools.')
    // 历史事实仍在，但不与当前轮混淆
    expect(system).toContain(PROVENANCE_SENTINEL)
    expect(system).toMatch(/a web search tool is available this turn/)
    expect(system).toMatch(/EARLIER turn, NOT the current turn/i)
    ctx.storage.close()
  })
})

describe('历史搜索失败（工具报错）', () => {
  it('最终 system 标明失败，不宣称成功、不展示来源', async () => {
    const ctx = await setup(false)
    seedUser(ctx.messages, '查一下')
    seq++
    ctx.messages.create({
      id: `a-fail-${seq}`, conversationId: 'conv-1', segmentId: 'seg-1', role: 'assistant',
      content: '抱歉，搜索失败', attachments: [], reasoningMeta: null, reasoningText: null,
      reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: 'SEARCH_TIMEOUT',
      status: 'completed', modelId: MODEL, reasoningEffort: null,
      providerTurnId: null, providerItemId: null,
      providerPayloadJson: JSON.stringify({
        provider: 'custom', protocol: 'chat_completions',
        items: [
          { type: 'function_call', call_id: 'c-fail', name: 'openchat_web_search', arguments: '{"query":"q"}' },
          { type: 'function_call_output', call_id: 'c-fail', output: JSON.stringify({ error: 'SEARCH_TIMEOUT', message: 'timeout' }) },
        ],
      }),
      errorCode: null, errorMessage: null, createdAt: seq, updatedAt: seq,
    })

    const body = await sendAndCapture(ctx.service, '刚才搜到了什么？')
    const system = systemOf(body)

    expect(system).toContain(PROVENANCE_SENTINEL)
    expect(system).toMatch(/outcome: failed/)
    expect(system).toMatch(/SEARCH_TIMEOUT/)
    expect(system).not.toMatch(/results returned:/)
    expect(system).not.toMatch(/recorded sources/)
    // 允许承认不确定 / 纠正
    expect(system).toMatch(/describe the uncertainty/i)
    expect(system).not.toMatch(/Do not deny, retract, or contradict/i)
    ctx.storage.close()
  })
})

describe('无历史搜索时（第 1 轮 OFF）保持既有行为', () => {
  it('cc 协议仍注入 NO_SEARCH_CAPABILITY_NOTICE，且无 provenance', async () => {
    const ctx = await setup(false)
    const body = await sendAndCapture(ctx.service, '你好')
    const system = systemOf(body)

    expect(system).toContain(NO_SEARCH_SENTINEL)
    expect(system).not.toContain(PROVENANCE_SENTINEL)
    expect(body.tools).toBeUndefined()
    ctx.storage.close()
  })
})