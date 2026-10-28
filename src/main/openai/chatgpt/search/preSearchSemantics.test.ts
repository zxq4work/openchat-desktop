import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

// 只构造最终请求，不发网络请求。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { StorageService } from '../../../storage/StorageService'
import { ConversationRepository } from '../../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../../storage/MessageRepository'
import { ChatGPTConversationService } from '../ChatGPTConversationService'
import { ChatCompletionsAdapter } from '../../../providers/ChatCompletionsAdapter'
import { ResponsesAdapter } from '../../../providers/ResponsesAdapter'
import { buildAnthropicRequestBody } from '../../../providers/anthropic/AnthropicRequestBuilder'
import type { Conversation, Message, ContextSegment } from '../../../../shared/types/conversation'
import type { CanonicalModelRequest, ProviderProtocol } from '../../../../shared/types/provider'
import type { PreSearchTurnOutcome } from '../ChatGPTConversationService'

// =====================================================================
// 回归：PreSearch 本轮语义（ON + 成功 / 0 结果 / 失败）
//
// 关键不变量：只要用户开启了搜索功能，最终请求绝不出现「搜索已关闭 / 建议开启搜索」
// 这类关闭语义；且本轮预搜索的真实结果（成功 / 0 条 / 失败）必须如实表达。
// 同时验证三协议（anthropic_messages / chat_completions / responses）语义一致，
// 仅序列化字段不同。
// 另：搜索 OFF 且无历史 → 三协议都注入统一 NOTICE。
// =====================================================================

let dir: string
let storage: StorageService
let conversations: ConversationRepository
let segments: ContextSegmentRepository
let messages: MessageRepository

beforeEach(async () => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-presearch-'))
  storage = new StorageService(join(dir, 'openchat.db'))
  await storage.init()
  conversations = new ConversationRepository(storage)
  segments = new ContextSegmentRepository(storage)
  messages = new MessageRepository(storage)
})

afterEach(() => {
  storage.close()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const MODEL = 'test-model'

function seed(): { conversationId: string; segmentId: string } {
  const conversationId = 'conv-1'
  const segmentId = 'seg-1'
  const conv: Conversation = {
    id: conversationId, type: 'chat', title: 't', systemPrompt: '', systemPromptRevision: 0,
    defaultModelId: MODEL, defaultReasoningEffort: null, currentSegmentId: segmentId,
    useModelInstructions: false, webSearchEnabled: true, codexSearchMode: 'hosted',
    searchEngine: 'bing', providerConfigId: 'prov-1',
    defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
    providerNameSnapshot: null, modelNameSnapshot: null,
    requestParameterValues: {}, createdAt: 1, updatedAt: 1,
  }
  conversations.create(conv)
  const seg: ContextSegment = {
    id: segmentId, conversationId, sequence: 0, reason: 'conversation-created',
    providerThreadId: null, systemPromptRevision: 0, systemPromptSnapshot: '', createdAt: 1,
  }
  segments.create(seg)
  return { conversationId, segmentId }
}

let seq = 0
function addMessage(conversationId: string, segmentId: string, role: 'user' | 'assistant', content: string, overrides: Partial<Message> = {}): Message {
  seq++
  const msg: Message = {
    id: `m-${seq}`, conversationId, segmentId, role, content,
    attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
    webSearchResults: null, webSearchError: null, status: 'completed',
    modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
    providerPayloadJson: null, errorCode: null, errorMessage: null,
    createdAt: seq, updatedAt: seq,
    ...overrides,
  }
  messages.create(msg)
  return msg
}

function makeService(): ChatGPTConversationService {
  return new ChatGPTConversationService(
    storage,
    { listModels: async () => [], sendResponses: async function* () {} } as never,
    { getInstructionsTemplate: () => null, getModelInfo: () => undefined, currentModels: [] } as never,
    {} as never,
    { getState: () => ({ state: 'ok' }), refresh: async () => {}, markExhaustedFrom429: () => {} } as never,
    { getDefinitions: () => [], getExecutor: () => undefined, has: () => false } as never,
    { getEngineName: () => 'bing', setEngine: () => {}, search: async () => [], setMaxResults: () => {} } as never,
    { listSafe: () => [], getAdapter: () => { throw new Error('unused') }, getBaseUrl: () => null, getResolvedRequestParameters: () => [] } as never,
  )
}

interface BuildArgs {
  segmentId: string
  protocol: ProviderProtocol
  searchEnabledThisTurn?: boolean
  preSearchOutcome?: PreSearchTurnOutcome
  skipWebSearchHistory?: boolean
  instructions?: string
}

function build(service: ChatGPTConversationService, a: BuildArgs): CanonicalModelRequest {
  return (service as unknown as {
    buildCanonicalRequest: (
      m: string, i: string, s: string, u: string, e: string, p?: ProviderProtocol,
      skip?: boolean, lite?: boolean, attribution?: unknown,
      searchEnabledThisTurn?: boolean, preSearchOutcome?: PreSearchTurnOutcome
    ) => CanonicalModelRequest
  }).buildCanonicalRequest(
    MODEL, a.instructions ?? 'BASE', a.segmentId, 'q', '', a.protocol,
    a.skipWebSearchHistory ?? true, undefined, undefined,
    a.searchEnabledThisTurn, a.preSearchOutcome
  )
}

// 只列出「强断言用户已关闭搜索」的模板标志。注意：新文案含否定句
// "Do not say search is disabled."，故不能用裸 "search is disabled" 作为哨兵。
const CLOSED_SENTINELS = [
  'no web search tool is provided for this turn',
  'they can enable web search',
  'You do not have web search tools available',
  'The user has just toggled web search OFF',
]

// CanonicalModelRequest.systemPrompt 可选；构建成功时必非空，这里归一化为 string。
const sys = (req: CanonicalModelRequest): string => req.systemPrompt ?? ''

function expectNotClosed(system: string): void {
  for (const s of CLOSED_SENTINELS) {
    expect(system, `must not contain closed-semantics "${s}"`).not.toContain(s)
  }
}

const PROTOCOLS: ProviderProtocol[] = ['anthropic_messages', 'chat_completions', 'responses']

describe('PreSearch（搜索开启、无 tools）— 三协议语义一致，绝不声称搜索关闭', () => {
  for (const outcome of ['succeeded', 'empty', 'failed'] as PreSearchTurnOutcome[]) {
    it(`outcome=${outcome} → 不注入关闭语义，且如实表达本轮搜索结果`, () => {
      const { segmentId } = seed()
      const service = makeService()
      for (const protocol of PROTOCOLS) {
        const req = build(service, { segmentId, protocol, searchEnabledThisTurn: true, preSearchOutcome: outcome })
        const system = sys(req)
        expectNotClosed(system)
        // 本轮搜索事实按 outcome 如实表达（不再用笼统的 "ALREADY performed"）
        expect(system).toContain('web search is enabled')
        expect(system).toMatch(/No web search tool is exposed to the model/i)
        if (outcome === 'empty') {
          expect(system).toMatch(/executed for this turn and returned no matching results/i)
          expect(system).not.toMatch(/executed successfully/i)
        }
        if (outcome === 'failed') {
          expect(system).toMatch(/attempted for this turn, but the operation failed/i)
          expect(system).not.toMatch(/executed successfully/i)
        }
        if (outcome === 'succeeded') {
          expect(system).toMatch(/executed successfully for this turn/i)
          expect(system).toMatch(/Search results are provided/i)
        }
        // 本轮无 tools
        expect(req.tools).toBeUndefined()
      }
    })
  }

  it('模型判定无需搜索（searchEnabled=true，无 outcome）→ 仍不注入关闭语义，也不声称本轮已搜索', () => {
    const { segmentId } = seed()
    const service = makeService()
    for (const protocol of PROTOCOLS) {
      const req = build(service, { segmentId, protocol, searchEnabledThisTurn: true })
      expectNotClosed(sys(req))
      // 未执行预搜索 → 不得出现任何「本轮已执行搜索」的肯定断言
      expect(req.systemPrompt).not.toMatch(/a search was ALREADY performed for you this turn/i)
      expect(req.systemPrompt).not.toMatch(/executed successfully for this turn/i)
      expect(req.systemPrompt).not.toMatch(/A web search was (executed|attempted)/i)
    }
  })

  it('有历史搜索时，PreSearch(empty/failed) 与历史 Provenance 并存，互不冒充', () => {
    const { conversationId, segmentId } = seed()
    addMessage(conversationId, segmentId, 'user', '旧问题')
    addMessage(conversationId, segmentId, 'assistant', '旧回答', {
      providerPayloadJson: JSON.stringify({
        provider: 'custom', protocol: 'chat_completions',
        items: [
          { type: 'function_call', call_id: 'c1', name: 'openchat_web_search', arguments: '{"query":"old"}' },
          { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ query: 'old', results: [{ title: 'T', url: 'https://t' }] }) },
        ],
      }),
    })
    const service = makeService()
    for (const protocol of PROTOCOLS) {
      const req = build(service, { segmentId, protocol, searchEnabledThisTurn: true, preSearchOutcome: 'empty' })
      // 历史 provenance 仍在，且声明「历史≠当前轮」
      expect(req.systemPrompt).toContain('OPENCHAT_SEARCH_PROVENANCE_V1')
      expect(req.systemPrompt).toMatch(/EARLIER turn, NOT the current turn/i)
      // 本轮预搜索如实说明，且不与历史混淆
      expect(req.systemPrompt).toMatch(/returned NO matching results/i)
      expectNotClosed(sys(req))
    }
  })
})

describe('搜索 OFF —— 三协议行为一致', () => {
  it('OFF、无历史 → buildCanonicalRequest 层不注入 Provenance（NOTICE 由 runGenerationDirect 层追加）', () => {
    // 说明：NOTICE 的注入点在 runGenerationDirect / shouldIncludeNoSearchNotice，
    // 其「三协议 OFF 无历史均注入 NOTICE」已由 anthropicPlainChatRequest.test.ts 的
    // 端到端用例（真实 wire body）覆盖。此处只断言构建器层的结构事实：无历史即无 Provenance。
    const { segmentId } = seed()
    const service = makeService()
    for (const protocol of PROTOCOLS) {
      const req = build(service, { segmentId, protocol, searchEnabledThisTurn: false })
      expect(req.systemPrompt ?? '').not.toContain('OPENCHAT_SEARCH_PROVENANCE_V1')
    }
  })

  it('OFF、有历史 → 三协议都保留 Provenance 且不注入 NOTICE', () => {
    const { conversationId, segmentId } = seed()
    addMessage(conversationId, segmentId, 'user', '旧问题')
    addMessage(conversationId, segmentId, 'assistant', '旧回答', {
      providerPayloadJson: JSON.stringify({
        provider: 'custom', protocol: 'chat_completions',
        items: [
          { type: 'function_call', call_id: 'c1', name: 'openchat_web_search', arguments: '{"query":"old"}' },
          { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ query: 'old', results: [{ title: 'T', url: 'https://t' }] }) },
        ],
      }),
    })
    const service = makeService()
    for (const protocol of PROTOCOLS) {
      const req = build(service, { segmentId, protocol, searchEnabledThisTurn: false })
      expect(req.systemPrompt).toContain('OPENCHAT_SEARCH_PROVENANCE_V1')
      expect(req.systemPrompt).toContain('no web search tool is provided for this turn')
      expect(req.systemPrompt).not.toContain('You do not have web search tools available')
    }
  })
})

// 序列化层：三协议业务规则一致，仅字段承载不同。
describe('协议序列化 —— 语义一致、字段不同', () => {
  it('同一 PreSearch(succeeded) 请求在三种 Adapter 的 wire 中 system 文本相同', () => {
    const { segmentId } = seed()
    const service = makeService()

    // Anthropic 走独立的 body 构建函数（无 buildRequest）；用同一 encoder 占位。
    const anthropicReq = build(service, { segmentId, protocol: 'anthropic_messages', searchEnabledThisTurn: true, preSearchOutcome: 'succeeded' })
    const anthropicBody = buildAnthropicRequestBody(anthropicReq, { encode: () => null })
    const anthropicSystem = typeof anthropicBody.system === 'string' ? anthropicBody.system : ''

    const ccReq = build(service, { segmentId, protocol: 'chat_completions', searchEnabledThisTurn: true, preSearchOutcome: 'succeeded' })
    const ccBody = (new ChatCompletionsAdapter({ baseUrl: 'https://x', apiKey: 'k', toolCalling: true }) as unknown as {
      buildRequest(r: CanonicalModelRequest): { messages: Array<{ role: string; content: string }> }
    }).buildRequest(ccReq)
    const ccSystem = ccBody.messages.find((m) => m.role === 'system')?.content ?? ''

    const respReq = build(service, { segmentId, protocol: 'responses', searchEnabledThisTurn: true, preSearchOutcome: 'succeeded' })
    const respBody = (new ResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k', toolCalling: true }) as unknown as {
      buildRequest(r: CanonicalModelRequest): { instructions?: string }
    }).buildRequest(respReq)
    const respSystem = respBody.instructions ?? ''

    expect(anthropicSystem).toBe(ccSystem)
    expect(ccSystem).toBe(respSystem)
    expect(anthropicSystem).toMatch(/executed successfully for this turn/i)
  })

  it('三协议在「本轮无实际搜索（outcome 未定义）」下系统提示一致，且均不声称已搜索', () => {
    const { conversationId, segmentId } = seed()
    // 存在历史成功搜索
    addMessage(conversationId, segmentId, 'user', '旧问题')
    addMessage(conversationId, segmentId, 'assistant', '旧回答', {
      providerPayloadJson: JSON.stringify({
        provider: 'custom', protocol: 'chat_completions',
        items: [
          { type: 'function_call', call_id: 'c1', name: 'openchat_web_search', arguments: '{"query":"old"}' },
          { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ query: 'old', results: [{ title: 'T', url: 'https://t' }] }) },
        ],
      }),
    })
    const service = makeService()

    const anthropicReq = build(service, { segmentId, protocol: 'anthropic_messages', searchEnabledThisTurn: true })
    const anthropicBody = buildAnthropicRequestBody(anthropicReq, { encode: () => null })
    const anthropicSystem = typeof anthropicBody.system === 'string' ? anthropicBody.system : ''
    const ccReq = build(service, { segmentId, protocol: 'chat_completions', searchEnabledThisTurn: true })
    const ccSystem = (new ChatCompletionsAdapter({ baseUrl: 'https://x', apiKey: 'k', toolCalling: true }) as unknown as {
      buildRequest(r: CanonicalModelRequest): { messages: Array<{ role: string; content: string }> }
    }).buildRequest(ccReq).messages.find((m) => m.role === 'system')?.content ?? ''
    const respReq = build(service, { segmentId, protocol: 'responses', searchEnabledThisTurn: true })
    const respSystem = (new ResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k', toolCalling: true }) as unknown as {
      buildRequest(r: CanonicalModelRequest): { instructions?: string }
    }).buildRequest(respReq).instructions ?? ''

    expect(anthropicSystem).toBe(ccSystem)
    expect(ccSystem).toBe(respSystem)
    // 历史 Provenance 保留，且明确本轮未确认搜索执行
    expect(ccSystem).toContain('OPENCHAT_SEARCH_PROVENANCE_V1')
    expect(ccSystem).toMatch(/If no such notice is present, no search execution is confirmed/i)
    // 不得出现旧的「本轮已代为执行」肯定断言
    expect(ccSystem).not.toMatch(/a search was ALREADY performed for you this turn/i)
    expect(ccSystem).not.toMatch(/A web search was (executed|attempted)/i)
  })
})
