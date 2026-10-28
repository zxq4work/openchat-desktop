import { randomUUID } from 'crypto'
import { ConversationRepository } from '../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../storage/MessageRepository'
import { ImageGenerationRepository } from '../../storage/ImageGenerationRepository'
import { StorageService } from '../../storage/StorageService'
import { resolveProviderSwitch } from '../../conversation/typeLocking'
import { resolveConversationBinding, bindingBlockedMessage } from '../../../shared/conversation/capabilities'
import { reconcileImageDefaults } from '../../../shared/image-generation/parameterProfile'
import { resolveParameterValues } from '../../../shared/request-parameters/requestParameters'
import type {
  Conversation,
  ContextSegment,
  Message,
  MessageAttachment,
  ConversationType,
} from '../../../shared/types/conversation'
import type { ModelInfo } from '../../../shared/types/model'
import type { CanonicalMessage, CanonicalModelRequest, CanonicalInputPart, CanonicalToolCall, CanonicalWebSearchCall, ProviderPayloadItem, ProviderPayloadV2, ProviderProtocol, AttachmentResolver, RequestParameterValues, ResolvedRequestParameter } from '../../../shared/types/provider'
import { AttachmentService } from '../../services/attachments/AttachmentService'
import { MAX_IMAGES_PER_MESSAGE, TITLE_MAX_LENGTH } from '../../../shared/constants'
import type { ChatGPTCodexClient } from './transport/ChatGPTCodexClient'
import { UsageLimitReachedError } from './transport/ChatGPTCodexClient'
import type { ChatGPTModelService } from './models/ChatGPTModelService'
import { resolveAllSearchProvenance, buildAllProvenanceContext, type SearchTurnMode } from './search/SearchProvenanceResolver'
import { shouldIncludeNoSearchNotice } from './searchNoticePolicy'
import {
  splitAttributionRequest,
  buildHostedAttributionStatement,
} from './search/attributionRequest'
import { segmentNeedsNonLiteForHostedHistory } from './search/searchHistoryCompatibility'
import {
  partitionToolHistoryByPortability,
  buildReadOnlyToolHistoryContent,
  type ReadOnlyHistoryToolCall,
} from './history/toolHistoryPortability'
import { findSupersededUserMessageIds, buildHistoricalFailureContext } from './history/supersededUserMessages'
import { ToolLoopController } from '../../tools/ToolLoopController'
import type { ToolLoopCallbacks, WebSearchCallEvent } from '../../tools/ToolLoopController'
import { ToolRegistry } from '../../tools/ToolRegistry'
import { ReadHistoryTool, READ_HISTORY_TOOL_NAME } from '../../tools/history/ReadHistoryTool'
import { WebSearchService } from '../../web-search/WebSearchService'
import { getSearchEngine } from '../../web-search/SearchEngineFactory'
import { ProviderConfigService, computeReservedRequestPaths, findDynamicParameterConflict } from '../../providers/ProviderConfigService'
import { logRequestParameterError } from '../../providers/requestDebug'
import { ChatGPTCodexAdapter } from '../../providers/ChatGPTCodexAdapter'
import type { ModelAdapter } from '../../../shared/types/provider'
import type { OAuthCredentialManager } from './auth/OAuthCredentialManager'
import type { WebSearchConfig } from '../../../shared/types/settings'
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../../shared/types/settings'
import { ChatGPTUsageService } from './usage/ChatGPTUsageService'
import { CodexUsageExhaustedError } from '../../../shared/types/usage'
import { hostnameFromUrl } from '../../../shared/utils/searchDisplay'
import type { SearchCommands } from '../../../shared/types/webSearch'
import { supportsImageFromModalities } from '../../../shared/utils/imageCapability'
import { resolveEffectiveResponsesLite } from './transport/responsesTransportPolicy'
import { ChatGPTCodexStandaloneSearchClient } from './search/ChatGPTCodexStandaloneSearchClient'
import { mergeHostedWebSearchResults } from './search/hostedSearchResults'
import {
  buildStandaloneWebSearchResults,
  dedupeWeatherServiceSources,
  parseRunCommands,
} from './search/standaloneSourceAdapter'
import {
  CODEX_SEARCH_INSTRUCTIONS,
  CODEX_STANDALONE_SEARCH_INSTRUCTIONS,
  CODEX_HOSTED_SEARCH_MODE_MARKER,
  CODEX_STANDALONE_SEARCH_MODE_MARKER,
} from './search/codexSearchInstructions'
import { CodexStandaloneWebRunTool } from './tools/CodexStandaloneWebRunTool'
import { cleanCitationText, CitationStreamBuffer } from '../../services/ai/CitationParser'
import { citationDebugTracker } from '../../services/ai/CitationDebugTracker'
import { UnsupportedImageInputError, CodexProtocolIsolationError } from '../../providers/errors'
import type { ConversationSearchResult, ConversationMessageSearchMatch, ConversationSearchScope } from '../../../shared/types/search'
import { buildSnippet, scopeMatchesContent, scopeMatchesTitle, aggregateConversationSearchResults, type ConversationSummaryRow } from '../../../shared/search/conversationSearch'

const SEARCH_INSTRUCTIONS = `Web access is available through OpenChat tools.

When you truly need external or up-to-date information, you may call openchat_web_search.
If the existing conversation context is sufficient to answer, answer directly without searching again.

Use openchat_web_search when:
- the user explicitly asks to search, browse, look up, find or verify information;
- the answer depends on current or potentially changed information;
- external verification would materially improve accuracy.

Use openchat_web_fetch when a search result snippet is insufficient and you need details from a source.

Prefer concise search queries.
Prefer primary and authoritative sources when possible.
Never claim that you searched the web unless a web tool was actually executed.
When using web results, cite relevant source URLs in the final answer.`

const NO_SEARCH_CAPABILITY_NOTICE = `You do not have web search tools available for this request. Answer directly based on your training knowledge and the conversation context.
- Do NOT output any search-related syntax (no <tool_call>, no <!-- START: WEB_SEARCH_CALL -->, no function calls).
- Do NOT mention that search is "disabled" or "unavailable" — just answer the question directly.
- If the user explicitly asks you to search or look something up, simply say you're unable to look that up right now and suggest they try enabling web search.`

// PreSearch 本轮的真实执行结果（仅当搜索功能开启且已代为执行预搜索时存在）。
//   succeeded  已执行搜索并得到结果（results > 0）
//   empty      已执行搜索，但没有匹配结果（results === 0）
//   failed     已尝试搜索，但搜索失败
export type PreSearchTurnOutcome = 'succeeded' | 'empty' | 'failed'

// 本轮预搜索结果的如实说明（低层执行事实，不是历史记录）。
// 头部只陈述「能力」：搜索已开启、本轮未暴露工具给模型、不得自行发起工具调用、不得说成关闭。
// 本轮是否真的执行过搜索，完全由 outcome 分支单独陈述（绝不把「开启」等同于「已执行」）。
function buildPreSearchTurnNotice(outcome: PreSearchTurnOutcome): string {
  const head = `CURRENT TURN: web search is enabled in OpenChat. No web search tool is exposed to the model in this request. Do not emit tool-call syntax. Do not describe web search as disabled.`
  switch (outcome) {
    case 'succeeded':
      return `${head}
A web search was executed successfully for this turn.
Search results are provided in this request.
Use those results and cite sources where appropriate.`
    case 'empty':
      return `${head}
A web search was executed for this turn and returned no matching results.
Do not invent results or source URLs.`
    case 'failed':
      return `${head}
A web search was attempted for this turn, but the operation failed.
Do not claim the search succeeded or invent results.
Do not claim web search is disabled.`
  }
}

// 脱敏诊断：只记录 System Prompt 的「来源布尔 + 长度」，绝不打印 Prompt 正文 / 用户对话 / 凭证。
// 仅在显式开启 OPENCHAT_DEBUG_SYSTEM_PROMPT=1 时输出，避免生产日志噪声。
export function logSystemPromptDebug(info: {
  webSearch: boolean
  hasModelInstructions: boolean
  baseMetadataLength: number
  finalLength: number
}): void {
  const enabled = process.env.OPENCHAT_DEBUG_SYSTEM_PROMPT === '1' || process.env.OPENCHAT_DEBUG_SYSTEM_PROMPT === 'true'
  if (!enabled) return
  const sources: string[] = []
  if (info.baseMetadataLength > 0) sources.push('baseMetadata')
  if (info.hasModelInstructions) sources.push('modelInstructions')
  console.log('[SystemPromptDebug] sources=%s baseLen=%d finalLen=%d webSearch=%s',
    sources.join(','), info.baseMetadataLength, info.finalLength, info.webSearch)
}

// 判断某个模型是否支持图片输入。
// - ChatGPT Codex：以模型 metadata 的 inputModalities 为准（三态语义，见 supportsImageFromModalities）
//   inputModalities 缺失 = 能力未知 = 不阻止图片；只有明确返回不含 'image' 的数组才阻止。
// - 自定义 Provider：无可靠 metadata，使用 Provider 配置的显式 imageInput 开关
// 绝不根据模型名猜测。
function modelSupportsImage(modelId: string, models: ModelInfo[], adapter: ModelAdapter): boolean {
  if (adapter.protocol === 'chatgpt_codex') {
    const model = models.find((m) => m.id === modelId)
    return !!model && supportsImageFromModalities(model.inputModalities)
  }
  return adapter.capabilities.supportsImageInput
}

// 该 message 是否包含需要作为图片 replay 的附件。
// 只统计 Chat 图片输入（usage=chat_input），不包含图片生成参考图 / 生成结果，
// 避免 Image Generation 的附件进入 Chat 上下文与图片能力门禁。
function messageHasImages(msg: Message): boolean {
  return msg.role === 'user' && Array.isArray(msg.attachments) && msg.attachments.some((a) => a.type === 'image' && a.usage === 'chat_input')
}

// Chat 历史重建时只取 Chat 图片输入；generation_input / generation_output 不得进入 replay。
function chatInputImages(msg: Message): MessageAttachment[] {
  if (!Array.isArray(msg.attachments)) return []
  return msg.attachments.filter((a) => a.type === 'image' && a.usage === 'chat_input')
}

export class ImageInputUnsupportedError extends Error {
  code = 'IMAGE_INPUT_UNSUPPORTED'
  constructor() {
    super('当前话题包含图片上下文，所选模型不支持图片输入。请选择支持图片的模型，或开始新话题。')
    this.name = 'ImageInputUnsupportedError'
  }
}

export interface StreamEvent {
  type: 'delta' | 'reasoning-started' | 'reasoning-delta' | 'reasoning-completed' | 'turn-started' | 'item-started' | 'item-completed' | 'turn-completed' | 'error' | 'web-search-started' | 'web-search-completed' | 'web-search-error' | 'web-search-call-started' | 'web-search-call-completed' | 'web-search-call-failed' | 'stream-reset'
  conversationId?: string
  turnId?: string
  itemId?: string
  text?: string
  status?: string
  errorCode?: string
  errorMessage?: string
  reasoningMeta?: import('../../../shared/types/conversation').ReasoningMeta
  toolCallId?: string
  toolCallName?: string
  toolCallArgs?: string
  toolCallError?: string
  webSearchResults?: unknown[]
  // 终态时间戳：turn-completed / error 时由 Main 写入，供 Renderer 展示
  // 「回答完成时间」。是主进程真实完成时刻，绝非渲染时生成的时间。
  completedAt?: number
}

type ToolCapability = 'unknown' | 'supported' | 'unsupported' | 'nonstandard'

export class ChatGPTConversationService {
  private conversations: ConversationRepository
  private segments: ContextSegmentRepository
  private messages: MessageRepository
  private storage: StorageService
  // 会话删除时同步清理 image_generations 记录（延迟注入，避免与 ImageGenerationService 循环依赖）
  private imageGenerations: ImageGenerationRepository | null = null
  private codexClient: ChatGPTCodexClient
  private modelService: ChatGPTModelService
  private standaloneSearchClient: ChatGPTCodexStandaloneSearchClient
  private toolRegistry: ToolRegistry
  private webSearchService: WebSearchService
  private providerConfigService: ProviderConfigService
  private usageService: ChatGPTUsageService
  private webSearchConfig: WebSearchConfig
  private attachmentService: AttachmentService | null = null
  // 是否向 tool-calling 会话注册统一只读历史工具（openchat_read_history）。
  // 默认开启；由构造参数注入，便于测试或按配置关闭，绝不内联硬编码。
  private readHistoryToolEnabled: boolean

  // 全局只允许一个 active generation
  private activeGeneration: {
    conversationId: string
    assistantMessageId: string | null
    abortController: AbortController | null
  } | null = null

  // 缓存每个 provider+model+endpoint 的 tool capability（runtime memory only）
  // key: `${providerId}|${protocol}|${modelId}|${endpoint}`
  private toolCapabilityCache = new Map<string, ToolCapability>()

  private streamHandlers: Array<(event: StreamEvent) => void> = []

  constructor(
    storage: StorageService,
    codexClient: ChatGPTCodexClient,
    modelService: ChatGPTModelService,
    credentialManager: OAuthCredentialManager,
    usageService: ChatGPTUsageService,
    toolRegistry: ToolRegistry,
    webSearchService: WebSearchService,
    providerConfigService: ProviderConfigService,
    webSearchConfig?: WebSearchConfig,
    readHistoryToolEnabled?: boolean
  ) {
    this.storage = storage
    this.conversations = new ConversationRepository(storage)
    this.segments = new ContextSegmentRepository(storage)
    this.messages = new MessageRepository(storage)
    this.codexClient = codexClient
    this.modelService = modelService
    this.standaloneSearchClient = new ChatGPTCodexStandaloneSearchClient(credentialManager)
    this.toolRegistry = toolRegistry
    this.webSearchService = webSearchService
    this.providerConfigService = providerConfigService
    this.usageService = usageService
    this.webSearchConfig = webSearchConfig ?? { ...DEFAULT_WEB_SEARCH_CONFIG }
    this.readHistoryToolEnabled = readHistoryToolEnabled ?? true
  }

  onStreamEvent(handler: (event: StreamEvent) => void): () => void {
    this.streamHandlers.push(handler)
    // 返回 disposer：Retry / service 重建前先解绑旧实例，避免同一 handler 重复订阅。
    return () => {
      const idx = this.streamHandlers.indexOf(handler)
      if (idx >= 0) this.streamHandlers.splice(idx, 1)
    }
  }

  setAttachmentService(service: AttachmentService): void {
    this.attachmentService = service
  }

  setImageGenerationRepository(repo: ImageGenerationRepository): void {
    this.imageGenerations = repo
  }

  private emitStreamEvent(event: StreamEvent): void {
    // 终态事件补上真实完成时间戳（主进程时钟），供 UI 展示回答完成时间
    if ((event.type === 'turn-completed' || event.type === 'error') && event.completedAt === undefined) {
      event.completedAt = Date.now()
    }
    // 发送 UI 前检查是否仍有 citation 泄漏
    if (event.type === 'delta' && event.text) {
      citationDebugTracker.checkEmit(event.text)
    }
    for (const handler of this.streamHandlers) {
      handler(event)
    }
  }

  listConversations(): Conversation[] {
    const summaries = this.conversations.listSummaries()
    return summaries.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      systemPrompt: '',
      systemPromptRevision: 0,
      defaultModelId: null,
      defaultReasoningEffort: null,
      currentSegmentId: '',
      useModelInstructions: true,
      webSearchEnabled: false,
      codexSearchMode: 'hosted',
      searchEngine: 'bing',
      providerConfigId: null,
      defaultImageSize: null,
      defaultImageQuality: null,
      defaultImageBackground: null,
      providerNameSnapshot: null,
      modelNameSnapshot: null,
      requestParameterValues: {},
      createdAt: 0,
      updatedAt: s.updatedAt,
      }))
  }

  getConversation(id: string): {
    conversation: Conversation
    segments: ContextSegment[]
    messages: Message[]
  } | null {
    const t0 = performance.now()

    const t1 = performance.now()
    const conversation = this.conversations.getById(id)
    const t2 = performance.now()
    if (!conversation) return null

    const segments = this.segments.getByConversationId(id)
    const t3 = performance.now()
    const messages = this.messages.getByConversationId(id)
    const t4 = performance.now()

    console.log('[perf] getConversation sql|conv=%dms segments=%dms messages=%dms total=%dms count=%d',
      Math.round(t2 - t1), Math.round(t3 - t2), Math.round(t4 - t3), Math.round(t4 - t0),
      messages.length)

    return { conversation, segments, messages }
  }

  // 全局会话搜索：直接查询本地数据库全部历史消息，不依赖 Renderer 已加载数据。
  // 只读，绝不修改会话 / 消息 / 排序 / updatedAt。
  // 结果按 Conversation 聚合（一个会话只出现一次），并返回最佳正文命中片段。
  searchConversations(query: string, scope: ConversationSearchScope): ConversationSearchResult[] {
    const q = String(query ?? '').trim()
    if (!q) return []

    const wantContent = scopeMatchesContent(scope)
    const contentHits = wantContent ? this.messages.searchMessagesByContent(q) : []

    // 候选会话摘要 = 标题匹配 ∪ 正文命中会话
    const lower = q.toLowerCase()
    const summaryMap = new Map<string, ConversationSummaryRow>()
    if (scopeMatchesTitle(scope)) {
      for (const s of this.conversations.listSummaries()) {
        if (s.title.toLowerCase().includes(lower)) {
          summaryMap.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt })
        }
      }
    }
    const missing = [...new Set(contentHits.map((h) => h.conversationId))].filter((id) => !summaryMap.has(id))
    if (missing.length > 0) {
      for (const s of this.conversations.getSummariesByIds(missing)) {
        summaryMap.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt })
      }
    }

    return aggregateConversationSearchResults({
      query: q,
      scope,
      candidateSummaries: [...summaryMap.values()],
      contentHits,
    })
  }

  // 当前会话内所有正文匹配消息（供左右导航栏跳转）。
  searchMatches(conversationId: string, query: string): ConversationMessageSearchMatch[] {
    const q = String(query ?? '').trim()
    if (!q || !conversationId) return []
    return this.messages.searchMatchesInConversation(conversationId, q).map((m) => ({
      messageId: m.messageId,
      role: m.role,
      snippet: buildSnippet(m.content, q),
      createdAt: m.createdAt,
    }))
  }

  createConversation(defaultModelId: string | null, defaultReasoningEffort: string | null, systemPrompt = '', providerConfigId: string | null = null, webSearchEnabled = false, searchEngine: 'bing' | 'baidu' | 'google' = 'bing', type: ConversationType = 'chat'): Conversation {
    const now = Date.now()
    const conversationId = randomUUID()
    const segmentId = randomUUID()

    const conversation: Conversation = {
      id: conversationId,
      type,
      title: '新对话',
      systemPrompt,
      systemPromptRevision: 0,
      defaultModelId,
      defaultReasoningEffort,
      currentSegmentId: segmentId,
      useModelInstructions: true,
      webSearchEnabled,
      codexSearchMode: 'hosted',
      searchEngine,
      providerConfigId,
      defaultImageSize: null,
      defaultImageQuality: null,
      defaultImageBackground: null,
      providerNameSnapshot: null,
      modelNameSnapshot: null,
      requestParameterValues: {},
      createdAt: now,
      updatedAt: now,
    }

    const segment: ContextSegment = {
      id: segmentId,
      conversationId,
      sequence: 0,
      reason: 'conversation-created',
      providerThreadId: null,
      systemPromptRevision: 0,
      systemPromptSnapshot: systemPrompt,
      createdAt: now,
    }

    this.conversations.create(conversation)
    this.segments.create(segment)

    return conversation
  }

  renameConversation(id: string, title: string): void {
    this.conversations.rename(id, title)
  }

  async removeConversation(id: string): Promise<void> {
    // 先清理附件文件与记录，再删除会话（文件失败不影响会话删除）
    try {
      if (this.attachmentService) this.attachmentService.deleteForConversation(id)
    } catch (err) {
      console.error('[ConversationService] attachment cleanup failed for conversation %s:', id, err)
    }
    try {
      this.imageGenerations?.removeByConversationId(id)
    } catch (err) {
      console.error('[ConversationService] image_generations cleanup failed for conversation %s:', id, err)
    }
    this.conversations.remove(id)
    await this.storage.save()
  }

  async removeAllConversations(): Promise<void> {
    try {
      if (this.attachmentService) {
        const ids = this.conversations.listSummaries().map((c) => c.id)
        this.attachmentService.deleteForConversations(ids)
      }
    } catch (err) {
      console.error('[ConversationService] attachment cleanup failed for remove-all:', err)
    }
    try {
      this.imageGenerations?.removeAll()
    } catch (err) {
      console.error('[ConversationService] image_generations cleanup failed for remove-all:', err)
    }
    this.conversations.removeAll()
    await this.storage.save()
  }

  updateRole(id: string, newSystemPrompt: string): void {
    const conversation = this.conversations.getById(id)
    if (!conversation) return

    const currentSegment = this.segments.getById(conversation.currentSegmentId)
    if (!currentSegment) return

    const hasMessages = this.messages.getBySegmentId(currentSegment.id).length > 0

    if (!hasMessages) {
      const db = this.storage.database
      db.run(
        `UPDATE context_segments SET system_prompt_snapshot = ? WHERE id = ?`,
        [newSystemPrompt, currentSegment.id]
      )
      this.conversations.updateSystemPrompt(id, newSystemPrompt, conversation.systemPromptRevision)
    } else {
      const newRevision = conversation.systemPromptRevision + 1
      const now = Date.now()
      const segmentId = randomUUID()

      const newSegment: ContextSegment = {
        id: segmentId,
        conversationId: id,
        sequence: this.segments.getNextSequence(id),
        reason: 'system-prompt-changed',
        providerThreadId: null,
        systemPromptRevision: newRevision,
        systemPromptSnapshot: newSystemPrompt,
        createdAt: now,
      }

      this.segments.create(newSegment)
      this.conversations.updateSystemPrompt(id, newSystemPrompt, newRevision)
      this.conversations.updateCurrentSegment(id, segmentId)
    }
  }

  // modelId 允许为 null：用于「无可用可见模型」时把会话置回「未选择模型」态
  // （与 createConversation(null) 同一语义）。空串同样归一化为 null，避免写入不可用 id。
  async updateModel(id: string, modelId: string | null): Promise<void> {
    const conversation = this.conversations.getById(id)
    if (!conversation) throw new Error('会话不存在')
    const normalized = modelId && modelId.length > 0 ? modelId : null
    // 记录 Provider/Model 名称快照，供失效时展示历史绑定。自定义 Provider 的模型名即 modelId。
    // 不改变会话类型：模型切换只影响下一条消息使用的 model。清空模型时不覆盖旧名称快照。
    const provider = conversation.providerConfigId
      ? this.providerConfigService.listSafe().find((p) => p.id === conversation.providerConfigId) ?? null
      : null
    this.conversations.updateModel(id, normalized)
    if (normalized) {
      this.conversations.updateBindingSnapshot(id, provider?.name ?? conversation.providerNameSnapshot, normalized)
    }
    await this.storage.save()
  }

  async updateEffort(id: string, effort: string): Promise<void> {
    const conversation = this.conversations.getById(id)
    if (conversation?.type === 'image_generation') {
      throw new Error('图片生成会话不支持推理强度')
    }
    this.conversations.updateEffort(id, effort)
    await this.storage.save()
  }

  // Image Generation 会话默认图片参数更新
  async updateImageDefaults(id: string, size: string | null, quality: string | null, background: string | null): Promise<void> {
    const conversation = this.conversations.getById(id)
    if (!conversation || conversation.type !== 'image_generation') {
      throw new Error('当前会话不是图片生成会话')
    }
    this.conversations.updateImageDefaults(id, size, quality, background)
    await this.storage.save()
  }

  // 通用动态请求参数值更新（chat / image_generation 会话均可）。
  // values 只包含用户显式覆盖的参数；unset 的 key 不存在。
  async updateRequestParameterValues(id: string, values: RequestParameterValues): Promise<void> {
    const conversation = this.conversations.getById(id)
    if (!conversation) throw new Error('会话不存在')
    this.conversations.updateRequestParameterValues(id, values ?? {})
    await this.storage.save()
  }

  newTopic(id: string): ContextSegment | null {
    const conversation = this.conversations.getById(id)
    if (!conversation) return null
    // 图片生成会话无上下文段语义，新话题无意义
    if (conversation.type === 'image_generation') return null

    const now = Date.now()
    const segmentId = randomUUID()

    const newSegment: ContextSegment = {
      id: segmentId,
      conversationId: id,
      sequence: this.segments.getNextSequence(id),
      reason: 'new-topic',
      providerThreadId: null,
      systemPromptRevision: conversation.systemPromptRevision,
      systemPromptSnapshot: conversation.systemPrompt,
      createdAt: now,
    }

    this.segments.create(newSegment)
    this.conversations.updateCurrentSegment(id, segmentId)

    return newSegment
  }

  async sendMessage(conversationId: string, text: string, attachmentIds: string[] = []): Promise<{ userMessage: Message; assistantMessage: Message; reasoningDisplayMode: 'none' | 'summary' | 'live' }> {
    console.log('[SendMessage] entry conversationId=%s activeGeneration=%s attachmentIds=%d', conversationId, this.activeGeneration ? `set(conv=${this.activeGeneration.conversationId})` : 'null', attachmentIds.length)
    if (this.activeGeneration) {
      console.log('[SendMessage] BLOCKED: activeGeneration still set')
      throw new Error('已有正在进行的生成')
    }

    const conversation = this.conversations.getById(conversationId)
    if (!conversation) { console.log('[SendMessage] FAIL: conversation not found'); throw new Error('会话不存在') }

    // 会话类型门禁：图片生成会话只能走 ImageGenerationService，绝不进 chat 路径
    if (conversation.type === 'image_generation') {
      throw new Error('当前会话为图片生成会话，不能发送聊天消息')
    }
    // Provider binding 兼容性门禁。会话类型由 conversation.type 决定（权威），
    // Provider 协议只是兼容性约束：Provider 被改成 image_generations 只代表「原绑定失效」，
    // 绝不改变会话类型，也绝不把错误表述成「会话已锁定为图片生成」。
    const binding = resolveConversationBinding({
      conversationType: conversation.type,
      providerConfigId: conversation.providerConfigId,
      modelId: conversation.defaultModelId,
      providers: this.providerConfigService.listSafe(),
    })
    if (binding.status === 'provider_incompatible' || binding.status === 'provider_missing' || binding.status === 'model_missing') {
      throw new Error(bindingBlockedMessage(binding.status, conversation.type))
    }

    // 动态请求参数门禁：请求构建前再次校验（不信任 UI，也防 DB 旧脏值）。
    // 参数非法 → 阻止发送并给出可操作提示，绝不静默改值 / 静默丢弃。
    if (conversation.providerConfigId) {
      this.assertDynamicParametersValid(conversation.providerConfigId, conversation.defaultModelId, conversation.requestParameterValues ?? {})
    }

    const segment = this.segments.getById(conversation.currentSegmentId)
    if (!segment) { console.log('[SendMessage] FAIL: segment not found currentSegmentId=%s', conversation.currentSegmentId); throw new Error('当前上下文段不存在') }

    const modelId = conversation.defaultModelId
    if (!modelId) { console.log('[SendMessage] FAIL: no modelId'); throw new Error('未选择模型，请先刷新模型列表') }

    // 图片能力拦截：待发送的 draft 图片 + 当前 segment 需要 replay 的历史图片
    // 任一存在而所选模型不支持图片输入 → 阻止发送，保留 draft。
    // 附件记录从 DB 读取（避免渲染进程伪造 metadata）。
    const attachmentService = this.attachmentService
    const draftAttachments: MessageAttachment[] = attachmentIds.length > 0 && attachmentService
      ? attachmentIds
          .map((id) => attachmentService.getAttachment(id))
          .filter((a): a is MessageAttachment => a !== null)
      : []

    const segmentMessagesForGate = this.messages.getBySegmentId(segment.id)
    const historyHasImage = segmentMessagesForGate.some(messageHasImages)
    const hasImage = draftAttachments.length > 0 || historyHasImage
    if (draftAttachments.length > MAX_IMAGES_PER_MESSAGE) {
      throw new Error(`单条消息最多支持 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
    }
    if (hasImage) {
      const adapterForGate = this.resolveAdapter(conversation.providerConfigId)
      const supportsImage = modelSupportsImage(modelId, this.modelService.currentModels, adapterForGate)
      if (!supportsImage) {
        console.log('[SendMessage] BLOCKED: image required but model unsupported modelId=%s historyImg=%s draftImg=%d', modelId, historyHasImage, draftAttachments.length)
        throw new ImageInputUnsupportedError()
      }
    }

    let effort = conversation.defaultReasoningEffort
    if (effort && effort.includes('[object Object]')) {
      effort = null
    }

    const currentModel = this.modelService.currentModels.find((m) => m.id === modelId)
    if (effort && currentModel) {
      const supported = currentModel.supportedReasoningEfforts.map((s) => s.reasoningEffort)
      if (!supported.includes(effort)) {
        effort = this.modelService.resolveEffort(currentModel, null)
        this.conversations.updateEffort(conversationId, effort ?? '')
        await this.storage.save()
      }
    }

    // 自定义服务：若 adapter 不支持推理，清除 effort 避免 400
    const adapter = this.resolveAdapter(conversation.providerConfigId)
    if (!adapter.capabilities.reasoning && effort) {
      effort = null
    }

    // 根据 Provider 协议在发送前确定 reasoningDisplayMode，整条 turn 生命周期不可变：
    // - chatgpt_codex（Codex 原生）：只返回 summary，永远 summary
    // - chat_completions（Qwen/DeepSeek 等）：通过 reasoning_content 返回实时 delta，live
    // - responses（第三方 Responses API）：返回 reasoning_text delta，live
    // - 无推理能力的 provider：none
    const reasoningDisplayMode: 'none' | 'summary' | 'live' =
      !adapter.capabilities.reasoning
        ? 'none'
        : adapter.protocol === 'chatgpt_codex'
          ? 'summary'
          : 'live'

    const effortValue = effort ?? ''

    const usageState = this.usageService.getState()
    // 使用自定义服务时，跳过 Codex 额度检查
    if (!conversation.providerConfigId && usageState.state === 'exhausted') {
      const nowMs = Date.now()
      if (usageState.resetAt && usageState.resetAt * 1000 > nowMs) {
        throw new CodexUsageExhaustedError(usageState.resetAt, usageState.usage?.plan_type)
      }
    }

    const now = Date.now()
    const userMessage: Message = {
      id: randomUUID(),
      conversationId,
      segmentId: segment.id,
      role: 'user',
      content: text,
      attachments: draftAttachments,
      reasoningMeta: null,
      reasoningText: null,
      reasoningDisplayMode: 'none',
      webSearchResults: null,
      webSearchError: null,
      status: 'completed',
      modelId: conversation.defaultModelId,
      reasoningEffort: conversation.defaultReasoningEffort,
      providerTurnId: null,
      providerItemId: null,
      providerPayloadJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }
    this.messages.create(userMessage)
    // 草稿附件 → 正式的 message 归属（message_attachments 是归属唯一事实源）
    if (draftAttachments.length > 0 && this.attachmentService) {
      this.attachmentService.bindDrafts(draftAttachments.map((a) => a.id), userMessage.id, conversationId, segment.id)
    }

    if (conversation.title === '新对话') {
      const title = this.deriveTitle(text)
      this.conversations.rename(conversationId, title)
    }

    const assistantMessage: Message = {
      id: randomUUID(),
      conversationId,
      segmentId: segment.id,
      role: 'assistant',
      content: '',
      attachments: [],
      reasoningMeta: null,
      reasoningText: null,
      reasoningDisplayMode,
      webSearchResults: null,
      webSearchError: null,
      status: 'pending',
      modelId: conversation.defaultModelId,
      reasoningEffort: conversation.defaultReasoningEffort,
      providerTurnId: null,
      providerItemId: null,
      providerPayloadJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now + 1,
      updatedAt: now + 1,
    }
    this.messages.create(assistantMessage)

    const abortController = new AbortController()
    this.activeGeneration = {
      conversationId,
      assistantMessageId: assistantMessage.id,
      abortController,
    }
    console.log('[SendMessage] SET activeGeneration assistantMessageId=%s', assistantMessage.id)

    // 延迟到下一个宏任务执行 runGeneration，确保 sendMessage 的 IPC 响应
    // 先于错误事件到达渲染进程。否则当 runGeneration 同步抛出（如 Invalid URL）
    // 时，渲染进程会先收到 error 事件，此时 activeMessages 尚未追加消息，
    // onChatError 找不到 assistant 消息而跳过状态更新，导致 UI 一直显示"生成中..."
    setImmediate(() => {
      void this.runGeneration(
        conversationId,
        segment.systemPromptSnapshot,
        conversation.useModelInstructions,
        modelId,
        effortValue,
        assistantMessage.id,
        text,
        conversation.providerConfigId,
        abortController,
        conversation.webSearchEnabled,
        conversation.codexSearchMode,
        conversation.searchEngine,
        userMessage.id
      )
    })

    return { userMessage, assistantMessage, reasoningDisplayMode }
  }

  private resolveAdapter(providerConfigId: string | null): ModelAdapter {
    if (providerConfigId) {
      return this.providerConfigService.getAdapter(providerConfigId)
    }
    return new ChatGPTCodexAdapter(this.codexClient)
  }

  // Codex 路径：根据模型元数据决定是否启用 Responses Lite
  // 根据当前 Provider 决定搜索后端：Codex 使用原生搜索，自定义 Provider 使用 OpenChat 自定义搜索
  private resolveSearchStrategy(
    providerConfigId: string | null,
    webSearchEnabled: boolean,
    codexSearchMode: 'hosted' | 'standalone'
  ): 'none' | 'codex-hosted' | 'codex-standalone' | 'openchat-custom' {
    if (!webSearchEnabled) return 'none'
    if (providerConfigId === null) {
      return codexSearchMode === 'standalone' ? 'codex-standalone' : 'codex-hosted'
    }
    return 'openchat-custom'
  }

  private buildCapabilityCacheKey(
    providerConfigId: string | null,
    adapter: ModelAdapter,
    modelId: string
  ): string {
    // 需要拿到 endpoint，从 ProviderConfigService 取；无则用 providerConfigId 兜底
    let endpoint = ''
    if (providerConfigId) {
      endpoint = this.providerConfigService.getBaseUrl(providerConfigId) ?? ''
    }
    return `${providerConfigId ?? 'codex-default'}|${adapter.protocol}|${modelId}|${endpoint}`
  }

  // 正式 Transport Policy 入口：在 search strategy resolve 完成之后、buildCanonicalRequest 之前，
  // 计算本次请求唯一的 effectiveResponsesLite（驱动 header / reasoning.context /
  // parallel_tool_calls / tool serializer / include / tool_choice）。
  // 依据 model metadata 的 useResponsesLite + resolved searchStrategy，绝不做 env / slug 特判。
  // 额外条件：本次请求若需重放历史 hosted web_search_call（provider-native），
  // 则 codex-standalone 也必须整体走 Non-Lite，否则 Lite 会话携带 hosted wire item
  // 会被上游以 "response protection is unavailable" 拒绝（Hosted → Standalone 跨模式历史兼容）。
  private computeEffectiveResponsesLiteForRequest(modelId: string, searchStrategy: string, hasHostedWebSearchHistory: boolean): boolean {
    const modelWantsResponsesLite = this.modelService.getModelInfo(modelId)?.useResponsesLite === true
    const effective = resolveEffectiveResponsesLite({ modelWantsResponsesLite, searchStrategy, hasHostedWebSearchHistory })
    // dev invariant：codex-hosted 必须得到 Non-Lite；若为 true 说明 Policy 被破坏。
    // 生产环境不 crash，仅记录明确 error，由 Adapter 安全防线阻止非法 request。
    if (searchStrategy === 'codex-hosted' && effective && process.env.NODE_ENV !== 'production') {
      console.error('[Codex Transport] INVARIANT VIOLATION: searchStrategy=codex-hosted but effectiveResponsesLite=true (model=%s)', modelId)
    }
    return effective
  }

  // 检测 API 返回的错误是否表示不支持 tools（仅明确的 HTTP/API 错误）
  // 以下情况不能标记 unsupported：tool_choice required 不支持、timeout、HTTP 500、SSE 异常、模型本轮没调用工具
  private isToolsUnsupportedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    return (
      msg.includes('unsupported tool') ||
      msg.includes('unsupported_tools') ||
      msg.includes('tools is not supported') ||
      msg.includes('tools not supported') ||
      msg.includes('tools parameter is not supported') ||
      msg.includes('unknown parameter: tools') ||
      msg.includes('unknown parameter : tools') ||
      msg.includes('invalid parameter: tools') ||
      msg.includes('invalid parameter : tools') ||
      msg.includes('invalid tool type') ||
      (msg.includes('400') || msg.includes('422')) && (msg.includes('tool') || msg.includes('tools'))
    )
  }

  private async runGeneration(
    conversationId: string,
    systemPrompt: string,
    useModelInstructions: boolean,
    modelId: string,
    effort: string,
    assistantMessageId: string,
    userText: string,
    providerConfigId: string | null,
    abortController: AbortController,
    webSearchEnabled: boolean,
    codexSearchMode: 'hosted' | 'standalone',
    searchEngine: 'bing' | 'baidu' | 'google',
    currentUserMessageId?: string
  ): Promise<void> {
    console.log('[runGeneration] entry conversationId=%s modelId=%s providerConfigId=%s webSearch=%s', conversationId, modelId, providerConfigId ?? 'codex', webSearchEnabled)
    // 兜底图片能力拦截（sendMessage 已拦一次，这里覆盖 runGeneration 直接调用方）
    try {
      const adapter = this.resolveAdapter(providerConfigId)
      const segmentMessagesGate = this.messages.getBySegmentId(this.messages.getById(assistantMessageId)?.segmentId ?? '')
      if (segmentMessagesGate.some(messageHasImages) && !modelSupportsImage(modelId, this.modelService.currentModels, adapter)) {
        throw new ImageInputUnsupportedError()
      }

      const segmentId = this.messages.getById(assistantMessageId)?.segmentId ?? ''

      const modelInstructions = useModelInstructions
        ? (this.modelService.getInstructionsTemplate(modelId) ?? '')
        : ''
      // 基础 System Prompt 与协议无关：所有第三方协议（chat_completions / responses /
      // anthropic_messages）及 Codex 使用同一套规则——模型名 / 日期 / 时区 + 兜底角色 +
      // 'Additional info for this conversation:' 标题 + 用户提示词。
      // 协议只负责把这些内容序列化到各自的字段（system / instructions / 顶层 system），
      // 绝不因协议而省略或改写应用级提示词。
      // 用户提示词：未配置（含空串 / 仅空白）时使用统一兜底角色；配置后原样保留，
      // 并位于 metadata 之后（保持原有合并顺序与优先级）。
      const userPrompt = systemPrompt.trim()
        ? systemPrompt
        : 'You are a helpful assistant.'
      const metadataLines = [
        `Current model: ${modelId}`,
        `Current date: ${this.getLocalDate()}`,
        `Current timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      ]
      // userPrompt 恒非空（有兜底），因此始终追加标题与用户提示词，顺序与 Chat Completions 基线一致。
      const baseMetadata = [...metadataLines, 'Additional info for this conversation:', '', userPrompt].join('\n')

      // 本轮可信指令：基础 metadata + 当前模型 instructions。
      // 搜索模式的「本轮自我识别」内嵌在按策略隔离的搜索指令尾部（见 codexSearchInstructions），
      // 由对应生成路径在 instructions 之后拼接，无需在此单独追加声明。
      // 每轮都从会话快照重新计算，不与上一轮结果叠加（无累积）。
      const instructions = modelInstructions
        ? `${modelInstructions}\n\n${baseMetadata}`
        : baseMetadata

      logSystemPromptDebug({
        webSearch: webSearchEnabled,
        hasModelInstructions: !!modelInstructions,
        baseMetadataLength: baseMetadata.length,
        finalLength: instructions.length,
      })

      this.messages.updateStatus(assistantMessageId, 'streaming')

      const searchStrategy = this.resolveSearchStrategy(providerConfigId, webSearchEnabled, codexSearchMode)
      // 模型 catalog 明确声明不支持 hosted search（supports_search_tool === false）时，
      // 绝不发送已知不支持的 hosted-search tool；降级为无搜索直答并提示用户。
      // 仅 false 触发，undefined（服务器未声明）保持现有行为。
      let effectiveStrategy = searchStrategy
      if (searchStrategy === 'codex-hosted') {
        const modelInfo = this.modelService.getModelInfo(modelId)
        if (modelInfo?.supportsSearchTool === false) {
          console.log('[Search Strategy] model=%s supports_search_tool=false, downgrading hosted → none', modelId)
          effectiveStrategy = 'none'
          this.emitStreamEvent({
            type: 'web-search-error',
            conversationId,
            toolCallId: 'capability-guard',
            toolCallError: 'Selected model does not support hosted web search.',
          })
        }
      }
      const engineLabel = effectiveStrategy === 'codex-hosted'
        ? 'codex-hosted'
        : effectiveStrategy === 'codex-standalone'
          ? 'codex-standalone'
          : effectiveStrategy === 'openchat-custom'
            ? searchEngine
            : 'none'
      console.log('[Search Strategy] provider=%s strategy=%s engine=%s', providerConfigId ?? 'codex', effectiveStrategy, engineLabel)

      // 本轮搜索模式自我识别不再单独的 currentSearchMode 声明，而是内嵌在按策略隔离的
      // 搜索指令中（Hosted → CODEX_SEARCH_INSTRUCTIONS 尾部；Standalone → CODEX_STANDALONE_
      // SEARCH_INSTRUCTIONS 尾部）。每个模式只描述自身工具与自我识别，互不引入对方机制，
      // 避免叠加同义提示或在 Hosted 指令中出现 web.run 归因规则。

      // 正式 Transport Policy：search strategy resolve 完成后、发请求之前，
      // 计算本次唯一的 effectiveResponsesLite（codex-hosted → 强制 Non-Lite）。
      // 该值统一下传给所有 codex 生成路径，驱动 header / reasoning.context /
      // parallel_tool_calls / tool serializer / include / tool_choice。
      // 历史兼容条件：本次请求若需重放 hosted web_search_call（Hosted → Standalone 跨模式），
      // 也强制 Non-Lite，避免 Lite 会话携带 hosted wire item 被上游拒绝。
      // 检测范围必须与「实际发送的历史」一致：
      //   - codex-hosted / codex-standalone 会重放 provider 历史（不含 skipWebSearchHistory）；
      //   - codex-none 走 skipWebSearchHistory=true，不重放 web_search_call，故不触发；
      //   - openchat-custom 走自定义 Provider，不经 Codex 传输层。
      // 且仅统计 status==='completed' 的 assistant 消息，与 buildCanonicalRequest 完全一致。
      const replaysHostedHistory = effectiveStrategy === 'codex-hosted' || effectiveStrategy === 'codex-standalone'
      const segmentMessagesForHistory = this.messages.getBySegmentId(segmentId)
      const hasHostedWebSearchHistory = replaysHostedHistory && segmentNeedsNonLiteForHostedHistory(segmentMessagesForHistory)
      const effectiveResponsesLite = this.computeEffectiveResponsesLiteForRequest(modelId, effectiveStrategy, hasHostedWebSearchHistory)
      if (effectiveStrategy === 'codex-hosted' || effectiveStrategy === 'codex-standalone') {
        console.log('[Codex Transport] model=%s modelResponsesLite=%s effectiveResponsesLite=%s reason=%s hostedHistory=%s',
          modelId, String(this.modelService.getModelInfo(modelId)?.useResponsesLite === true),
          String(effectiveResponsesLite), effectiveStrategy, String(hasHostedWebSearchHistory))
      }

      // 自定义 Provider 时切换到当前会话的搜索引擎偏好
      const prevEngine = this.webSearchService.getEngineName()
      if (searchStrategy === 'openchat-custom' && searchEngine !== prevEngine) {
        this.webSearchService.setEngine(getSearchEngine(searchEngine), searchEngine)
      }

      switch (effectiveStrategy) {
        case 'codex-hosted': {
          // 工具归因分离（仅 Hosted）：识别「句尾独立归因要求」后，模型只回答实质问题，
          // 归因由本轮真实 web_search_call 事件在收尾处生成。未命中封闭短语表 → null，走原流程。
          const attribution = splitAttributionRequest(userText)
          await this.runGenerationWithCodexHostedSearch(
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, segmentId, abortController,
            effectiveResponsesLite,
            attribution ?? undefined,
            currentUserMessageId
          )
          break
        }

        case 'codex-standalone':
          await this.runGenerationWithCodexStandaloneSearch(
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, segmentId, abortController,
            effectiveResponsesLite
          )
          break

        case 'openchat-custom': {
          const cacheKey = this.buildCapabilityCacheKey(providerConfigId, adapter, modelId)
          const capability = this.toolCapabilityCache.get(cacheKey) ?? 'unknown'
          console.log('[Tool Capability] protocol=', adapter.protocol, 'model=', modelId, 'capability=', capability)

          if (capability === 'unsupported') {
            console.log('[Tool Decision] mode=presearch capability=', capability)
            await this.runGenerationWithPreSearch(
              conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, abortController
            )
          } else {
            console.log('[Tool Decision] mode=tools')
            try {
              await this.runGenerationWithTools(
                conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, segmentId, abortController
              )
              return
            } catch (err) {
              if (this.isToolsUnsupportedError(err)) {
                console.log('[Tool Fallback] reason=unsupported_tools cacheKey=', cacheKey)
                this.toolCapabilityCache.set(cacheKey, 'unsupported')
                this.messages.updateContent(assistantMessageId, '')
                this.emitStreamEvent({ type: 'stream-reset', conversationId })
                this.messages.updateStatus(assistantMessageId, 'streaming')
                await this.runGenerationWithPreSearch(
                  conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, abortController
                )
                return
              } else {
                throw err
              }
            }
          }
          break
        }

        case 'none':
          await this.runGenerationDirect(
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, segmentId, abortController,
            effectiveResponsesLite
          )
          break
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isAborted = abortController.signal.aborted

      console.log('[runGeneration] CATCH: message=%s isAborted=%s', message, isAborted)

      if (err instanceof UsageLimitReachedError) {
        this.usageService.markExhaustedFrom429(err.resetsAt)
        void this.usageService.refresh()
      }

      console.error('[ChatGPTConversationService] Stream error:', message, err instanceof Error ? err.stack : '')

      if (isAborted) {
        this.messages.updateStatus(assistantMessageId, 'stopped')
        this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'interrupted' })
      } else if (err instanceof ImageInputUnsupportedError || err instanceof UnsupportedImageInputError || err instanceof CodexProtocolIsolationError) {
        // 图片上下文不支持 / Standalone 协议隔离异常：显式失败，绝不静默降级或误报完成。
        this.messages.updateError(assistantMessageId, err.code, err.message)
        this.emitStreamEvent({ type: 'error', conversationId, errorCode: err.code, errorMessage: err.message })
      } else {
        const code = err instanceof UsageLimitReachedError ? 'CODEX_USAGE_EXHAUSTED' : 'StreamFailed'
        this.messages.updateError(assistantMessageId, code, message)
        this.emitStreamEvent({ type: 'error', conversationId, errorCode: code, errorMessage: message })
      }
    } finally {
      console.log('[runGeneration] FINALLY: assistantMessageId=%s activeGenerationAssistantMessageId=%s', assistantMessageId, this.activeGeneration?.assistantMessageId ?? 'null')
      this.messages.flushPendingReasoningText(assistantMessageId)
      if (this.activeGeneration?.assistantMessageId === assistantMessageId) {
        this.activeGeneration = null
        console.log('[runGeneration] FINALLY: cleared activeGeneration')
      } else {
        console.log('[runGeneration] FINALLY: did NOT clear activeGeneration (mismatch or null)')
      }
      await this.storage.save()
    }
  }

  // 对单个 delta 做 citation 清理，返回可安全输出的文本。
  // 流式场景下可能缓存不完整 marker，仅返回已确认安全的文本。
  private cleanDelta(citationBuf: CitationStreamBuffer, rawDelta: string): string {
    if (!rawDelta) return ''
    citationDebugTracker.feedRaw(rawDelta, 'cleanDelta')
    return citationBuf.feed(rawDelta)
  }

  // 流结束时刷新 citation 缓冲区，返回残余文本。
  private flushCitationBuffer(citationBuf: CitationStreamBuffer): string {
    return citationBuf.flush()
  }

  // 对完整文本做 citation 清理（非流式场景）。
  private cleanFinalText(text: string): string {
    if (!text) return ''
    citationDebugTracker.flush()
    const { cleanText } = cleanCitationText(text)
    return cleanText
  }

  // Agentic Search：使用 ToolLoopController
  private async runGenerationWithTools(
    conversationId: string,
    adapter: ModelAdapter,
    modelId: string,
    instructions: string,
    effort: string,
    assistantMessageId: string,
    userText: string,
    segmentId: string,
    abortController: AbortController
  ): Promise<void> {
    let accumulatedContent = ''
    const citationBuf = new CitationStreamBuffer()
    let providerTurnId: string | null = null
    let reasoningStartedAt: number | null = null
    let totalReasoningDuration = 0
    let reasoningTextAccum = ''

    // 统一只读历史工具：按当前会话消息构造，作用域限定在本会话。
    // 与联网工具（openchat_web_search / openchat_web_fetch）注册在同一循环内，
    // 使任意具备 tool-calling 能力的 Provider 都能通过统一接口按需读取真实历史结果。
    const roundRegistry = this.buildRoundToolRegistry(conversationId)

    const controller = new ToolLoopController(adapter, roundRegistry, undefined, { signal: abortController.signal, conversationId, segmentId, modelId }, {
      maxRounds: this.webSearchConfig.maxToolRounds,
    })

    const callbacks: ToolLoopCallbacks = {
      onToolCall: (toolCall: CanonicalToolCall) => {
        // 只读历史工具读取的是本地历史，不是联网搜索：不发出「搜索中」UI 事件。
        if (toolCall.name === READ_HISTORY_TOOL_NAME) return
        this.emitStreamEvent({
          type: 'web-search-started',
          conversationId,
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          toolCallArgs: toolCall.arguments,
        })
      },
      onToolResult: (callId, toolName, success, rawResults, errorOutput) => {
        // 只读历史工具无搜索结果卡片，不发出 web-search-* UI 事件。
        if (toolName === READ_HISTORY_TOOL_NAME) return
        if (toolName === 'openchat_web_fetch') {
          if (success) {
            this.emitStreamEvent({
              type: 'web-search-completed',
              conversationId,
              toolCallId: callId,
              webSearchResults: rawResults,
            })
          }
          return
        }
        // web_fetch 失败不应显示为"搜索失败"，仅 web_search 失败才触发错误提示
        if (toolName !== 'openchat_web_search') return

        if (success) {
          this.emitStreamEvent({
            type: 'web-search-completed',
            conversationId,
            toolCallId: callId,
            webSearchResults: rawResults,
          })
        } else {
          // 超限/重复查询/搜索失败跳过是护栏拦截，不是真正的搜索失败，不提示用户
          if (errorOutput && (errorOutput.includes('TOOL_LIMIT_EXCEEDED') || errorOutput.includes('DUPLICATE_QUERY') || errorOutput.includes('SEARCH_FAILED'))) {
            return
          }
          let userMessage = errorOutput ?? '搜索失败'
          if (errorOutput) {
            try {
              const parsed = JSON.parse(errorOutput) as Record<string, unknown>
              userMessage = (parsed.message as string) || (parsed.error as string) || errorOutput
            } catch {
              userMessage = errorOutput
            }
          }
          console.log('[WebSearch] search failed, callId=', callId, 'error=', userMessage)
          this.messages.updateWebSearchError(assistantMessageId, userMessage)
          this.emitStreamEvent({
            type: 'web-search-error',
            conversationId,
            toolCallId: callId,
            toolCallError: userMessage,
          })
        }
      },
      onDelta: (text) => {
        const cleanText = this.cleanDelta(citationBuf, text)
        if (!cleanText) return
        accumulatedContent += cleanText
        this.messages.updateContent(assistantMessageId, accumulatedContent)
        this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: cleanText })
      },
      onReasoningStarted: (itemId) => {
        reasoningStartedAt = Date.now()
        this.emitStreamEvent({ type: 'reasoning-started', conversationId, turnId: providerTurnId ?? '', itemId })
      },
      onReasoningDelta: (text) => {
        reasoningTextAccum += text
        this.messages.updateReasoningTextDebounced(assistantMessageId, reasoningTextAccum)
        this.emitStreamEvent({ type: 'reasoning-delta', conversationId, text })
      },
      onReasoningCompleted: (itemId, summary) => {
        const phaseDuration = reasoningStartedAt ? Date.now() - reasoningStartedAt : 0
        totalReasoningDuration += phaseDuration
        // 多阶段推理：累积 summary，不覆盖之前阶段的摘要
        const prevReasoning = this.messages.getById(assistantMessageId)?.reasoningMeta
        const accumulatedSummary = [...(prevReasoning?.summary ?? []), ...(summary ?? [])]
        const meta = {
          duration: totalReasoningDuration,
          effort: effort || '',
          summary: accumulatedSummary,
          available: accumulatedSummary.length > 0,
        }
        this.messages.updateReasoningMeta(assistantMessageId, meta)
        this.emitStreamEvent({ type: 'reasoning-completed', conversationId, turnId: providerTurnId ?? '', itemId, reasoningMeta: meta })
      },
      onTurnStarted: (turnId) => {
        if (turnId && !providerTurnId) {
          providerTurnId = turnId
          this.messages.updateProviderIds(assistantMessageId, turnId, '')
        }
        this.emitStreamEvent({ type: 'turn-started', conversationId, turnId })
      },
      getProviderTurnId: () => providerTurnId,
      setProviderTurnId: (id) => {
        providerTurnId = id
        this.messages.updateProviderIds(assistantMessageId, id, '')
      },
    }

    const fullInstructions = instructions + '\n\n' + SEARCH_INSTRUCTIONS
    const request = this.buildCanonicalRequest(modelId, fullInstructions, segmentId, userText, effort, adapter.protocol)

    const result = await controller.run(request, abortController.signal, callbacks)
    console.log('[Generation] ToolLoop done finalTextLength=%d totalToolCalls=%d', result.finalText?.length ?? 0, result.totalToolCalls)

    // 收到过 structured function_call → 确认 supported
    if (result.totalToolCalls > 0) {
      const cacheKey = this.buildCapabilityCacheKey(
        this.conversations.getById(conversationId)?.providerConfigId ?? null,
        adapter,
        modelId
      )
      this.toolCapabilityCache.set(cacheKey, 'supported')
    }
    // totalToolCalls === 0 → 模型直接回答，不改变 capability

    // 刷新 citation 缓冲区残余
    const flushText = this.flushCitationBuffer(citationBuf)
    if (flushText) {
      accumulatedContent += flushText
      this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: flushText })
    }
    const finalContent = this.cleanFinalText(accumulatedContent)
    this.messages.updateContent(assistantMessageId, finalContent)

    // 协议原生内容块 / usage / stop_reason（仅 Anthropic 等会发出 native_block 的协议非空）。
    if (result.finalNativeBlocks.length > 0 || result.nativeTranscript) {
      this.messages.updateProtocolBlocks(assistantMessageId, {
        protocol: adapter.protocol,
        modelId,
        blocks: result.finalNativeBlocks,
        ...(result.nativeTranscript ? { transcript: result.nativeTranscript } : {}),
      })
    }
    if (result.finalUsage?.raw) this.messages.updateUsage(assistantMessageId, result.finalUsage.raw)
    if (result.finalStopReason !== null && result.finalStopReason !== undefined) {
      this.messages.updateStopReason(assistantMessageId, result.finalStopReason)
    }

    this.messages.flushReasoningText(assistantMessageId, reasoningTextAccum)
    this.messages.updateStatus(assistantMessageId, 'completed')

    // 持久化搜索结果
    if (result.toolCallHistory.length > 0) {
      const allResults: Array<{ title: string | null; url: string | null; snippet: string | null }> = []
      for (const entry of result.toolCallHistory) {
        for (const item of entry.rawResults) {
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>
            allResults.push({
              title: (typeof obj.title === 'string' ? obj.title : null) ?? (typeof obj.name === 'string' ? obj.name : null),
              url: (typeof obj.url === 'string' ? obj.url : null) ?? (typeof obj.link === 'string' ? obj.link : null),
              snippet: (typeof obj.snippet === 'string' ? obj.snippet : null) ?? (typeof obj.description === 'string' ? obj.description : null),
            })
          }
        }
      }
      if (allResults.length > 0) {
        this.messages.updateWebSearchResults(assistantMessageId, allResults)
      }
    }

    // 持久化 provider-native tool history（V2 schema）
    // 按真实执行顺序保存 function_call + function_call_output 配对。
    // 只读历史工具（openchat_read_history）的调用不落库：它是「对历史的查看」，
    // 不是新产生的历史，避免每次读取都向历史追加一条自引用记录而无限增长。
    const completeToolHistoryCustom = result.toolCallHistory.filter(
      (entry) => entry.output && entry.name !== READ_HISTORY_TOOL_NAME
    )
    if (completeToolHistoryCustom.length > 0) {
      const customItems: ProviderPayloadItem[] = []
      for (const entry of completeToolHistoryCustom) {
        customItems.push({
          type: 'function_call',
          call_id: entry.callId,
          name: entry.name,
          ...(entry.namespace ? { namespace: entry.namespace } : {}),
          arguments: entry.arguments,
        })
        customItems.push({
          type: 'function_call_output',
          call_id: entry.callId,
          output: entry.output,
        })
      }
      this.messages.updateProviderPayload(assistantMessageId, {
        provider: 'custom',
        protocol: adapter.protocol,
        items: customItems,
      })
      console.log('[Provider History] save assistantId=%s provider=custom protocol=%s items=%d types=%s', assistantMessageId.slice(0, 8), adapter.protocol, customItems.length, customItems.map((i) => i.type).join(','))
    }

    this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
  }

  // 构造本轮的联网工具注册表：在共享的 web 工具之上，追加按当前会话作用域构造的
  // 只读历史工具（openchat_read_history）。
  // - 共享 web 工具（openchat_web_search / openchat_web_fetch）从 this.toolRegistry 复制，
  //   避免污染全局注册表；
  // - 只读历史工具读取当前会话已持久化的历史工具结果，作用域限定为本会话，绝无跨会话读取。
  private buildRoundToolRegistry(conversationId: string): ToolRegistry {
    const registry = new ToolRegistry()
    for (const def of this.toolRegistry.getDefinitions()) {
      const executor = this.toolRegistry.getExecutor(def.name)
      if (executor) registry.register(def.name, executor)
    }
    if (this.readHistoryToolEnabled) {
      const scopedMessages = this.messages.getByConversationId(conversationId)
      registry.register(READ_HISTORY_TOOL_NAME, new ReadHistoryTool(scopedMessages))
    }
    return registry
  }

  // Codex Hosted Search：官方 web_search 工具由服务端执行；同时通过 ToolLoop 追加
  // 统一只读历史工具（openchat_read_history），使 Hosted 轮也具备与 Standalone 相同的
  // 「按需读取历史工具真实结果」能力。
  //
  // 关键约束（绝不改变既有行为）：
  //   - 原生 web_search 仍通过 initialRequest.tools 声明（hosted wire），不进 ToolRegistry；
  //   - 只注册 read_history 一个 client 工具，绝不注册 openchat_web_search/web_fetch 或 run；
  //   - 原生 web_search_call 事件（itemId/status/action/sources）经 onWebSearchCall 完整保留；
  //   - read_history 调用不落库（避免历史自引用），web_search_call 仍按原样持久化。
  private async runGenerationWithCodexHostedSearch(
    conversationId: string,
    adapter: ModelAdapter,
    modelId: string,
    instructions: string,
    effort: string,
    assistantMessageId: string,
    userText: string,
    segmentId: string,
    abortController: AbortController,
    effectiveResponsesLite: boolean,
    attribution?: { modelText: string; language: 'zh' | 'en' },
    currentUserMessageId?: string
  ): Promise<void> {
    let accumulatedContent = ''
    const citationBuf = new CitationStreamBuffer()
    let providerTurnId: string | null = null
    let reasoningStartedAt: number | null = null
    let totalReasoningDuration = 0
    let reasoningTextAccum = ''
    const webSearchResults: Array<{ title: string | null; url: string | null; snippet: string | null; sourceType?: 'web' | 'api' }> = []
    const webSearchCallItems: Array<{ id: string; status?: string; action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string; sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> } }> = []

    const fullInstructions = instructions + '\n\n' + CODEX_SEARCH_INSTRUCTIONS
    const hostMarkerIdx = fullInstructions.indexOf(CODEX_HOSTED_SEARCH_MODE_MARKER)
    console.log('[Codex Search Semantics] mode=hosted selfId=%s', hostMarkerIdx >= 0 ? 'PRESENT' : 'NOT_FOUND')
    // effectiveResponsesLite 由 runGeneration 的 Transport Policy 统一计算并传入：
    // codex-hosted 恒为 Non-Lite（Lite 模型在此自动降级），无需任何 debug env。
    // 归因分离：模型只看到实质问题（attribution.modelText）；用户原文仍完整保存，不进入本轮请求。
    // 关键：替换 modelText 与「跳过原始用户消息」必须同时生效，否则会重复注入（原文 + 实质问题）。
    // 缺少 currentUserMessageId 时无法安全跳过 → 整体回退为原文，绝不半应用。
    const applySplit = !!(attribution && currentUserMessageId)
    const requestUserText = applySplit ? attribution!.modelText : userText
    const request = this.buildCanonicalRequest(
      modelId, fullInstructions, segmentId, requestUserText, effort, adapter.protocol, false, effectiveResponsesLite,
      applySplit ? { currentUserMessageId: currentUserMessageId! } : undefined
    )
    // 原生 web_search：hosted wire，经 initialRequest 顶层声明；绝不放进 ToolRegistry。
    request.tools = [{
      name: 'web_search',
      description: '',
      parameters: {},
      toolType: 'web_search',
    }]
    request.toolChoice = 'auto'

    // 只读历史工具注册表：仅 read_history。Hosted 不主动开放 Standalone 的 run，
    // 也不声明 openchat_web_search / openchat_web_fetch（原生搜索已由 web_search 承担）。
    const hostedRegistry = new ToolRegistry()
    if (this.readHistoryToolEnabled) {
      hostedRegistry.register(
        READ_HISTORY_TOOL_NAME,
        new ReadHistoryTool(this.messages.getByConversationId(conversationId))
      )
    }

    const controller = new ToolLoopController(
      adapter,
      hostedRegistry,
      undefined,
      { signal: abortController.signal, conversationId, segmentId, modelId },
      { maxRounds: this.webSearchConfig.maxToolRounds, replayHostedSearchCalls: true }
    )

    // 本轮是否观察到原生搜索失败事件（仅用于归因状态区分，不改动既有 UI/持久化语义）。
    let hostedSearchFailed = false

    // 原生 web_search_call 事件处理：完整保留 started/completed/failed 语义 + itemId/status/action/sources。
    const handleHostedWebSearchCall = (event: WebSearchCallEvent): void => {
      switch (event.phase) {
        case 'started':
          console.log('[Codex] web_search_call phase=started')
          this.emitStreamEvent({ type: 'web-search-call-started', conversationId })
          break
        case 'searching':
          break
        case 'completed': {
          // 本次事件开始前已有的来源数：用于只向渲染器增量发本次新增来源，
          // 避免多轮原生搜索在渲染器侧被重复累加（单次搜索时 slice 等于整段，输出不变）。
          const sourceCountBefore = webSearchResults.length
          const action = event.action ?? { type: 'search' }
          // 安全诊断日志：只打印 action.type / url hostname / query / pattern / resultsCount，不打印完整 URL query
          console.log(
            '[Codex Hosted Search] action=%s urlHost=%s query=%s pattern=%s resultsCount=%d',
            action.type ?? '(none)',
            action.url ? (hostnameFromUrl(action.url) || 'invalid') : '(none)',
            action.query ?? '(none)',
            action.pattern ?? '(none)',
            event.results?.length ?? 0
          )
          // 持久化 provider-native web_search_call item（用于跨 turn 模型记忆）
          if (event.itemId) {
            webSearchCallItems.push({
              id: event.itemId,
              status: event.status,
              action,
            })
          }
          if (event.results) {
            for (const item of event.results) {
              if (item && typeof item === 'object') {
                const obj = item as Record<string, unknown>
                const rawUrl = (typeof obj.url === 'string' ? obj.url : null) ?? (typeof obj.link === 'string' ? obj.link : null) ?? (typeof obj.uri === 'string' ? obj.uri : null)
                const rawTitle = (typeof obj.title === 'string' ? obj.title : null)
                const rawSnippet = (typeof obj.snippet === 'string' ? obj.snippet : null) ?? (typeof obj.description === 'string' ? obj.description : null)
                // 内置 API 引用（如 {"type":"api","name":"oai-weather"}），无 URL
                if (!rawUrl) {
                  const apiName = typeof obj.name === 'string' ? obj.name : ''
                  webSearchResults.push({
                    title: apiName ? `内置服务: ${apiName}` : '内置服务',
                    url: null,
                    snippet: rawSnippet,
                    sourceType: 'api',
                  })
                  continue
                }
                webSearchResults.push({
                  title: rawTitle ?? hostnameFromUrl(rawUrl),
                  url: rawUrl,
                  snippet: rawSnippet,
                  sourceType: 'web',
                })
              }
            }
          }
          // open_page 只带 action.url、action.sources 常为空，补进参考页面列表，
          // 使 Direct URL 访问的网页像普通 search source 一样可展开查看。
          const normalizedResults = mergeHostedWebSearchResults(action, webSearchResults)
          // 保持 webSearchResults 引用不变，供 turn 末尾统一持久化
          if (normalizedResults.length !== webSearchResults.length) {
            webSearchResults.push(...normalizedResults.slice(webSearchResults.length))
          }
          // 仅增量发出本次新增来源（渲染器按 append 语义累加），避免多轮重复。
          this.emitStreamEvent({ type: 'web-search-call-completed', conversationId, webSearchResults: webSearchResults.slice(sourceCountBefore) })
          console.log('[Codex] web_search_call emitted webSearchResults count=', webSearchResults.length, 'first=', webSearchResults[0] ? JSON.stringify(webSearchResults[0]) : '(empty)')
          break
        }
        case 'failed':
          hostedSearchFailed = true
          console.log('[Codex] web_search_call phase=failed')
          this.emitStreamEvent({ type: 'web-search-call-failed', conversationId })
          break
      }
    }

    const callbacks: ToolLoopCallbacks = {
      onToolCall: (toolCall: CanonicalToolCall) => {
        // 只读历史工具读取本地历史，不是联网搜索：不发出「搜索中」UI 事件。
        // 原生 web_search 不产生 tool_call 事件（走 web_search_call）。
        if (toolCall.name === READ_HISTORY_TOOL_NAME) return
        this.emitStreamEvent({
          type: 'web-search-started',
          conversationId,
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          toolCallArgs: toolCall.arguments,
        })
      },
      onToolResult: (callId, toolName, success, rawResults) => {
        // 只读历史工具无搜索结果卡片，不发出 web-search-* UI 事件。
        if (toolName === READ_HISTORY_TOOL_NAME) return
        if (success) {
          this.emitStreamEvent({
            type: 'web-search-completed',
            conversationId,
            toolCallId: callId,
            webSearchResults: rawResults,
          })
        }
      },
      onWebSearchCall: handleHostedWebSearchCall,
      onDelta: (text) => {
        const cleanText = this.cleanDelta(citationBuf, text)
        if (!cleanText) return
        accumulatedContent += cleanText
        this.messages.updateContent(assistantMessageId, accumulatedContent)
        this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: cleanText })
      },
      onReasoningStarted: (itemId) => {
        reasoningStartedAt = Date.now()
        this.emitStreamEvent({ type: 'reasoning-started', conversationId, turnId: providerTurnId ?? '', itemId })
      },
      onReasoningDelta: (text) => {
        reasoningTextAccum += text
        this.messages.updateReasoningTextDebounced(assistantMessageId, reasoningTextAccum)
        this.emitStreamEvent({ type: 'reasoning-delta', conversationId, text })
      },
      onReasoningCompleted: (itemId, summary) => {
        const phaseDuration = reasoningStartedAt ? Date.now() - reasoningStartedAt : 0
        totalReasoningDuration += phaseDuration
        const prevReasoning = this.messages.getById(assistantMessageId)?.reasoningMeta
        const accumulatedSummary = [...(prevReasoning?.summary ?? []), ...(summary ?? [])]
        const meta = {
          duration: totalReasoningDuration,
          effort: effort || '',
          summary: accumulatedSummary,
          available: accumulatedSummary.length > 0,
        }
        this.messages.updateReasoningMeta(assistantMessageId, meta)
        this.emitStreamEvent({ type: 'reasoning-completed', conversationId, turnId: providerTurnId ?? '', itemId, reasoningMeta: meta })
      },
      onTurnStarted: (turnId) => {
        if (turnId && !providerTurnId) {
          providerTurnId = turnId
          this.messages.updateProviderIds(assistantMessageId, turnId, '')
        }
        this.emitStreamEvent({ type: 'turn-started', conversationId, turnId })
      },
      getProviderTurnId: () => providerTurnId,
      setProviderTurnId: (id) => {
        providerTurnId = id
        this.messages.updateProviderIds(assistantMessageId, id, '')
      },
    }

    console.log('[Codex] runGenerationWithCodexHostedSearch model=%s conversationId=%s', modelId, conversationId)

    try {
      await controller.run(request, abortController.signal, callbacks)
    } catch (err) {
      if (abortController.signal.aborted) {
        return
      }
      throw err
    }
    // 轮间边界处被中断：不进入完成收尾（状态已由 interrupt() 置为 stopped）。
    if (abortController.signal.aborted) {
      return
    }

    const hostedFlushText = this.flushCitationBuffer(citationBuf)
    if (hostedFlushText) {
      accumulatedContent += hostedFlushText
      this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: hostedFlushText })
    }
    // 工具归因分离（仅命中封闭短语表的 S1 输入）：正文正常流式结束后，追加一次权威归因。
    // 归因只依据本轮真实 web_search_call 事件，绝不依据当前配置臆测。
    // 注意：此分支仅在 !aborted 且未抛错时到达；中断/失败路径在上面已 return/throw，不会追加。
    let finalContent = this.cleanFinalText(accumulatedContent)
    // 只有「拆分真正生效」（模型确实没看到归因要求）时才追加权威归因；
    // 否则回退为原行为，避免正文可能已有错误自述时再追加一条矛盾说明。
    if (applySplit && attribution) {
      const state = webSearchCallItems.length > 0 ? 'executed' : hostedSearchFailed ? 'failed' : 'notObserved'
      const statement = buildHostedAttributionStatement(state, attribution.language)
      const separator = finalContent.trim().length > 0 ? '\n\n' : ''
      const appended = separator + statement
      // 一个 delta 追加，随后持久化同一份文本 → 流式与落库严格一致，无重复消息、无重复 delta。
      this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: appended })
      finalContent = finalContent + appended
      console.log('[Tool Attribution] hosted state=%s lang=%s webSearchCalls=%d appended=true', state, attribution.language, webSearchCallItems.length)
    }
    this.messages.updateContent(assistantMessageId, finalContent)
    this.messages.flushReasoningText(assistantMessageId, reasoningTextAccum)
    this.messages.updateStatus(assistantMessageId, 'completed')

    if (webSearchResults.length > 0) {
      this.messages.updateWebSearchResults(assistantMessageId, webSearchResults)
    }

    // 持久化 provider-native tool history（V2 schema）：仅 web_search_call。
    // read_history 的 function_call/function_call_output 不落库（避免历史自引用、无限增长）。
    if (webSearchCallItems.length > 0) {
      this.messages.updateProviderPayload(assistantMessageId, {
        provider: 'chatgpt_codex',
        protocol: 'chatgpt_codex',
        items: webSearchCallItems.map((i) => ({ type: 'web_search_call' as const, id: i.id, status: i.status, action: i.action })),
      })
      console.log('[Provider History] save assistantId=%s provider=codex items=%d types=%s', assistantMessageId.slice(0, 8), webSearchCallItems.length, webSearchCallItems.map(() => 'web_search_call').join(','))
    }

    this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
  }

  // Codex Standalone Search：模型通过 web.run 工具自主调用 /alpha/search
  // 失败时仅报错，不回退到 Hosted
  private async runGenerationWithCodexStandaloneSearch(
    conversationId: string,
    adapter: ModelAdapter,
    modelId: string,
    instructions: string,
    effort: string,
    assistantMessageId: string,
    userText: string,
    segmentId: string,
    abortController: AbortController,
    effectiveResponsesLite: boolean
  ): Promise<void> {
    let accumulatedContent = ''
    const citationBuf = new CitationStreamBuffer()
    let providerTurnId: string | null = null
    let reasoningStartedAt: number | null = null
    let totalReasoningDuration = 0
    let reasoningTextAccum = ''
    // 按 callId 记录 run 的真实 commands 与成功状态，供构建展示来源（含内置服务来源）时
    // 以「实际提交的 weather 命令 + 真实执行成功」判定，绝不从自然语言推断。
    const runCallCommands = new Map<string, SearchCommands | undefined>()
    const runCallSuccess = new Map<string, boolean>()
    // 实时仅对内置天气服务来源去重，保留服务端返回的所有网页项（包括重复 URL）。
    let liveStandaloneSources: ReturnType<typeof buildStandaloneWebSearchResults> = []

    // 先构建 canonical request 以获取对话历史，传给 web.run 工具
    const standaloneInstructions = instructions + '\n\n' + CODEX_STANDALONE_SEARCH_INSTRUCTIONS
    const standaloneMarkerIdx = standaloneInstructions.indexOf(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    console.log('[Codex Search Semantics] mode=standalone selfId=%s', standaloneMarkerIdx >= 0 ? 'PRESENT' : 'NOT_FOUND')
    // effectiveResponsesLite 由 runGeneration 的 Transport Policy 统一计算并传入：
    //   无 hosted 历史 → 尊重模型 metadata（Lite 模型用 Lite）；
    //   含 hosted 历史 → 强制 Non-Lite（跨模式历史兼容，见 requiresNonLiteTransport）。
    const request = this.buildCanonicalRequest(modelId, standaloneInstructions, segmentId, userText, effort, adapter.protocol, undefined, effectiveResponsesLite)

    // 构建 web.run 工具注册表
    const standaloneToolRegistry = new ToolRegistry()
    const webRunTool = new CodexStandaloneWebRunTool(
      this.standaloneSearchClient,
      modelId,
      segmentId,
      request.messages
    )
    standaloneToolRegistry.register('run', webRunTool)

    // 统一只读历史工具：即使本会话此前由别的 Provider（如自定义 Provider 的 openchat_web_search）
    // 产生历史，Codex standalone 轮也能通过统一接口按需读取真实历史结果，无需理解原工具名。
    if (this.readHistoryToolEnabled) {
      standaloneToolRegistry.register(
        READ_HISTORY_TOOL_NAME,
        new ReadHistoryTool(this.messages.getByConversationId(conversationId))
      )
    }

    const controller = new ToolLoopController(adapter, standaloneToolRegistry, undefined, { signal: abortController.signal, conversationId, segmentId, modelId }, {
      maxRounds: this.webSearchConfig.maxToolRounds,
    })

    const callbacks: ToolLoopCallbacks = {
      onToolCall: (toolCall: CanonicalToolCall) => {
        if (toolCall.name === 'run') {
          runCallCommands.set(toolCall.id, parseRunCommands(toolCall.arguments))
        }
        // 只读历史工具读取的是本地历史，不是联网搜索：不发出「搜索中」UI 事件。
        if (toolCall.name === READ_HISTORY_TOOL_NAME) return
        this.emitStreamEvent({
          type: 'web-search-started',
          conversationId,
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          toolCallArgs: toolCall.arguments,
        })
      },
      // 协议隔离兜底：Standalone 轮不应产生新的 hosted web_search_call。
      // 历史回放不会 produce SSE（历史在 input，不出事件），故此处出现的必是本轮新调用。
      // 若发生：明确以错误结束本轮，绝不静默丢弃、也不误报为正常完成。
      onWebSearchCall: () => {
        console.error('[CodexStandalone] protocol isolation breach: unexpected hosted web_search_call in standalone turn')
        throw new CodexProtocolIsolationError()
      },
      onToolResult: (callId, toolName, success, rawResults) => {
        // 只读历史工具无搜索结果卡片，不发出 web-search-* UI 事件。
        if (toolName === READ_HISTORY_TOOL_NAME) return
        if (toolName === 'run') {
          if (callId) runCallSuccess.set(callId, success)
          if (success) {
            // 以增量形式发出来源，与持久化共用同一条「仅去重天气服务」规则。
            const callSources = buildStandaloneWebSearchResults(runCallCommands.get(callId), rawResults, true)
            const mergedSources = dedupeWeatherServiceSources([...liveStandaloneSources, ...callSources])
            const newSources = mergedSources.slice(liveStandaloneSources.length)
            liveStandaloneSources = mergedSources
            this.emitStreamEvent({
              type: 'web-search-completed',
              conversationId,
              toolCallId: callId,
              webSearchResults: newSources,
            })
          } else {
            this.emitStreamEvent({
              type: 'web-search-error',
              conversationId,
              toolCallId: callId,
            })
          }
        }
      },
      onDelta: (text) => {
        const cleanText = this.cleanDelta(citationBuf, text)
        if (!cleanText) return
        accumulatedContent += cleanText
        this.messages.updateContent(assistantMessageId, accumulatedContent)
        this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: cleanText })
      },
      onReasoningStarted: (itemId) => {
        reasoningStartedAt = Date.now()
        this.emitStreamEvent({ type: 'reasoning-started', conversationId, turnId: providerTurnId ?? '', itemId })
      },
      onReasoningDelta: (text) => {
        reasoningTextAccum += text
        this.messages.updateReasoningTextDebounced(assistantMessageId, reasoningTextAccum)
        this.emitStreamEvent({ type: 'reasoning-delta', conversationId, text })
      },
      onReasoningCompleted: (itemId, summary) => {
        const phaseDuration = reasoningStartedAt ? Date.now() - reasoningStartedAt : 0
        totalReasoningDuration += phaseDuration
        const prevReasoning = this.messages.getById(assistantMessageId)?.reasoningMeta
        const accumulatedSummary = [...(prevReasoning?.summary ?? []), ...(summary ?? [])]
        const meta = {
          duration: totalReasoningDuration,
          effort: effort || '',
          summary: accumulatedSummary,
          available: accumulatedSummary.length > 0,
        }
        this.messages.updateReasoningMeta(assistantMessageId, meta)
        this.emitStreamEvent({ type: 'reasoning-completed', conversationId, turnId: providerTurnId ?? '', itemId, reasoningMeta: meta })
      },
      onTurnStarted: (turnId) => {
        if (turnId && !providerTurnId) {
          providerTurnId = turnId
          this.messages.updateProviderIds(assistantMessageId, turnId, '')
        }
        this.emitStreamEvent({ type: 'turn-started', conversationId, turnId })
      },
      getProviderTurnId: () => providerTurnId,
      setProviderTurnId: (id) => {
        providerTurnId = id
        this.messages.updateProviderIds(assistantMessageId, id, '')
      },
    }

    const result = await controller.run(request, abortController.signal, callbacks)
    console.log('[CodexStandalone] ToolLoop done finalTextLength=%d totalToolCalls=%d', result.finalText?.length ?? 0, result.totalToolCalls)

    const standaloneFlushText = this.flushCitationBuffer(citationBuf)
    if (standaloneFlushText) {
      accumulatedContent += standaloneFlushText
      this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: standaloneFlushText })
    }
    this.messages.updateContent(assistantMessageId, this.cleanFinalText(accumulatedContent))
    this.messages.flushReasoningText(assistantMessageId, reasoningTextAccum)
    this.messages.updateStatus(assistantMessageId, 'completed')

    // 持久化展示来源：服务端网页 results +（真实成功 weather 时补充的）内置服务来源。
    if (result.toolCallHistory.length > 0) {
      const allResults: Array<{ title: string | null; url: string | null; snippet: string | null; sourceType?: 'web' | 'api' }> = []
      for (const entry of result.toolCallHistory) {
        if (entry.name !== 'run') continue
        const weatherSucceeded = runCallSuccess.get(entry.callId) === true
        const entryResults = buildStandaloneWebSearchResults(
          runCallCommands.get(entry.callId),
          entry.rawResults,
          weatherSucceeded
        )
        allResults.push(...entryResults)
      }
      // 仅合并重复的 oai-weather 服务来源；普通网页结果保持原有数量、顺序和重复项。
      const deduped = dedupeWeatherServiceSources(allResults)
      if (deduped.length > 0) {
        this.messages.updateWebSearchResults(assistantMessageId, deduped)
      }
    }

    // 持久化 provider-native tool history（V2 schema）
    // 按真实执行顺序保存 function_call + function_call_output 配对
    // 只保存有合法 output 的完整 pair（error output 也算合法）。
    // 只读历史工具（openchat_read_history）的调用不落库：它是「对历史的查看」，
    // 不是新产生的历史，避免每次读取都向历史追加一条自引用记录而无限增长。
    const completeToolHistory = result.toolCallHistory.filter(
      (entry) => entry.output && entry.name !== READ_HISTORY_TOOL_NAME
    )
    if (completeToolHistory.length > 0) {
      const items: ProviderPayloadItem[] = []
      for (const entry of completeToolHistory) {
        // 确保 namespace 不丢失：Codex SSE 可能不返回 namespace，但 ToolRegistry 定义中有
        const ns = entry.namespace ?? (entry.name === 'run' ? 'web' : undefined)
        items.push({
          type: 'function_call',
          call_id: entry.callId,
          name: entry.name,
          ...(ns ? { namespace: ns } : {}),
          arguments: entry.arguments,
        })
        items.push({
          type: 'function_call_output',
          call_id: entry.callId,
          output: entry.output,
        })
      }
      this.messages.updateProviderPayload(assistantMessageId, {
        provider: 'chatgpt_codex',
        protocol: 'chatgpt_codex',
        items,
      })
      console.log('[Provider History] save assistantId=%s provider=codex items=%d detail=%s', assistantMessageId.slice(0, 8), items.length, items.map((i) => {
        if (i.type === 'function_call') return `fc:${i.name}@${i.namespace ?? '?'}`
        if (i.type === 'function_call_output') return 'fco'
        return 'wsc'
      }).join(','))
    }

    this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
  }

  // PreSearch Mode：不支持 tool calling 时，先让模型提取搜索 query，再搜索并注入上下文
  private async runGenerationWithPreSearch(
    conversationId: string,
    adapter: ModelAdapter,
    modelId: string,
    instructions: string,
    effort: string,
    assistantMessageId: string,
    userText: string,
    abortController: AbortController
  ): Promise<void> {
    // Step 1: 让模型提取搜索 query（此时已显示搜索中状态）
    this.emitStreamEvent({
      type: 'web-search-started',
      conversationId,
      toolCallId: 'pre-search',
      toolCallName: 'openchat_web_search',
      toolCallArgs: JSON.stringify({ query: '正在分析搜索词...' }),
    })

    const segmentId = this.messages.getById(assistantMessageId)?.segmentId ?? ''
    const recentContext = this.buildRecentContext(segmentId)
    const searchQuery = await this.extractSearchQuery(adapter, modelId, userText, abortController, recentContext)
    console.log('[PreSearch] extracted query=', searchQuery)

    // 模型判定无需搜索（追问/澄清/已讨论内容），直接生成，跳过搜索
    if (!searchQuery) {
      // 清除之前发出的 "正在分析搜索词" 状态
      this.emitStreamEvent({
        type: 'web-search-completed',
        conversationId,
        toolCallId: 'pre-search',
        webSearchResults: [],
      })
      // 模型判定无需搜索：未执行任何预搜索，但用户**确实开启了搜索功能**。
      // 因此绝不注入「搜索已关闭」语义（searchEnabledThisTurn=true），
      // 也不存在本轮搜索执行结果（preSearchOutcome=undefined）。
      await this.runGenerationDirect(
        conversationId, adapter, modelId, instructions, effort, assistantMessageId, segmentId, abortController,
        undefined, true
      )
      return
    }

    // 更新搜索 query 为实际值
    this.emitStreamEvent({
      type: 'web-search-started',
      conversationId,
      toolCallId: 'pre-search',
      toolCallName: 'openchat_web_search',
      toolCallArgs: JSON.stringify({ query: searchQuery }),
    })

    let searchContext = ''
    let preSearchOutcome: PreSearchTurnOutcome = 'failed'
    try {
      const results = await this.webSearchService.search(searchQuery, abortController.signal)
      console.log('[PreSearch] query=', searchQuery, 'results count=', results.length)
      preSearchOutcome = results.length > 0 ? 'succeeded' : 'empty'
      if (results.length > 0) {
        const lines = [
          `You searched the web for: "${searchQuery}"`,
          'The search results are below. Present them as your own findings.',
          'Do NOT say "you provided" or "you searched" — you performed the search yourself.',
          'Do NOT output any function calling syntax (e.g., <tool_call>, <function>, <openchat_web_search>).',
          '',
          'Web search results:',
          '',
        ]
        for (const r of results) {
          lines.push(`[${r.index}]`)
          lines.push(`Title: ${r.title}`)
          lines.push(`URL: ${r.url}`)
          lines.push(`Snippet: ${r.snippet}`)
          lines.push('')
        }
        lines.push('Use these results only when relevant.')
        lines.push('Cite the source URL when relying on a result.')
        searchContext = lines.join('\n')
      }
      this.emitStreamEvent({
        type: 'web-search-completed',
        conversationId,
        toolCallId: 'pre-search',
        webSearchResults: results,
      })
    } catch (err) {
      console.error('[PreSearch] Search failed:', err instanceof Error ? err.message : String(err))
      let preSearchError = err instanceof Error ? err.message : '搜索失败'
      if (preSearchError.startsWith('SEARCH_')) {
        const colonIdx = preSearchError.indexOf(':')
        preSearchError = colonIdx > 0 ? preSearchError.slice(colonIdx + 2) : preSearchError
      }
      this.messages.updateWebSearchError(assistantMessageId, preSearchError)
      this.emitStreamEvent({
        type: 'web-search-error',
        conversationId,
        toolCallId: 'pre-search',
        toolCallError: preSearchError,
      })
    }

    // 本轮预搜索已实际执行（成功 / 0 结果 / 失败均由 preSearchOutcome 如实表达）。
    // 无论哪一种，用户都开启了搜索功能 → searchEnabledThisTurn=true，绝不注入关闭语义。

    // Responses 协议优先使用 developer message 承载本轮搜索结果。
    // 有结果时把结果文本作为 developer 注入；无结果 / 失败时退化到 system 的本轮说明
    //（与其它协议一致），不得因「无结果」而丢失「本轮已搜索」的事实。
    if (searchContext && adapter.protocol === 'responses') {
      const request = this.buildCanonicalRequestWithDeveloper(
        modelId, instructions, searchContext, segmentId, effort, adapter.protocol, preSearchOutcome
      )
      await this.runGenerationDirectStream(
        conversationId, adapter, request, assistantMessageId, abortController
      )
      return
    }

    // 有结果 → 作为附加上下文；无结果/失败 → 仅靠 buildCanonicalRequest 的本轮说明。
    const fullInstructions = searchContext
      ? instructions + '\n\n' + searchContext
      : instructions

    await this.runGenerationDirect(
      conversationId, adapter, modelId, fullInstructions, effort, assistantMessageId, segmentId, abortController,
      undefined, true, preSearchOutcome
    )
  }

  // 从当前 segment 的最近消息中提取简短上下文，帮助模型从模糊消息推断搜索词
  private buildRecentContext(segmentId: string, maxMessages = 4): string {
    const messages = this.messages.getBySegmentId(segmentId)
    // 取最后 maxMessages 条（跳过当前 pending/streaming 的 assistant 消息）
    const recent = messages
      .filter((m) => m.status === 'completed' || m.status === 'stopped')
      .slice(-maxMessages)
    if (recent.length === 0) return ''
    return recent
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`)
      .join('\n')
  }

  // 检测历史中是否有过搜索（通过 providerPayloadJson 或 webSearchResults 判断）
  private detectSearchWasEnabledInHistory(segmentMessages: Message[]): boolean {
    return segmentMessages.some(
      (m) =>
        m.role === 'assistant' &&
        (m.providerPayloadJson || (m.webSearchResults && m.webSearchResults.length > 0))
    )
  }

  // 当前上下文段是否已有可注入的搜索来源上下文（buildCanonicalRequest 的确定性 provenance）。
  // 有 provenance 时其 disabledNote 已完整覆盖「无当前工具 / 勿声称已搜索」，无需重复模板。
  private segmentHasSearchProvenance(segmentId: string): boolean {
    if (!segmentId) return false
    return resolveAllSearchProvenance(this.messages.getBySegmentId(segmentId)).length > 0
  }

  // 判断是否需要搜索，是则提取 query；否则返回空字符串跳过搜索
  private async extractSearchQuery(
    adapter: ModelAdapter,
    modelId: string,
    userText: string,
    abortController: AbortController,
    conversationContext?: string
  ): Promise<string> {
    const contextHint = conversationContext
      ? `\n\nRecent conversation context for reference:\n${conversationContext}`
      : ''
    const prompt = `The user has explicitly enabled web search. You must decide whether the following user message needs a web search.

Since the user turned on web search, lean toward searching. If the message is ambiguous (e.g. "再搜一下？", "search again", "tell me more"), infer the search topic from the conversation context and output a relevant search query.

If a web search IS needed, output the best search query on a single line.

If a web search is truly NOT needed (pure chitchat, no factual question at all), output only the word: NO_SEARCH

Do NOT think, reason, or explain. Output exactly one of:
- A search query (one line)
- NO_SEARCH

User message: ${userText}${contextHint}`
    const request: CanonicalModelRequest = {
      model: modelId,
      systemPrompt: 'You are a search decision assistant. The user has web search enabled — output a search query unless the message is pure chitchat with zero factual intent. No thinking, no reasoning, no explanation.',
      messages: [{ role: 'user', content: prompt }],
    }
    let query = ''
    let lastError = ''
    try {
      for await (const event of adapter.stream(request, abortController.signal)) {
        // 只收集正式 output_text delta，不收集 reasoning
        if (event.type === 'delta') {
          query += event.text
        }
        if (event.type === 'error') {
          lastError = event.message
          break
        }
        if (event.type === 'turn_completed') {
          break
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (lastError) console.error('[PreSearch] extractQuery error:', lastError)

    // 剥离 qwen 等模型的  thinking... response  XML 包装
    let cleaned = query.trim()
    const respStart = cleaned.lastIndexOf('<response>')
    if (respStart !== -1) {
      cleaned = cleaned.slice(respStart + '<response>'.length)
    }
    const respEnd = cleaned.indexOf('</response>')
    if (respEnd !== -1) {
      cleaned = cleaned.slice(0, respEnd)
    }
    cleaned = cleaned
      .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
      .replace(/^[Tt]hinking:.*$/gm, '')
      .replace(/^[Dd]ecision:.*$/gm, '')
      .trim()

    if (!cleaned || /^NO_SEARCH$/i.test(cleaned)) {
      return ''
    }
    return cleaned.slice(0, 500)
  }

  // 直接调用模型（无工具）
  private async runGenerationDirect(
    conversationId: string,
    adapter: ModelAdapter,
    modelId: string,
    instructions: string,
    effort: string,
    assistantMessageId: string,
    segmentId: string,
    abortController: AbortController,
    effectiveResponsesLite?: boolean,
    // 本轮 OpenChat 搜索功能是否已开启。注意：这描述的是「用户是否开启搜索」，
    // 与「本轮是否有可用工具 / 是否已执行预搜索」是不同维度——
    // 模型不能自行调用工具 ≠ 用户关闭了搜索。
    searchEnabledThisTurn = false,
    // PreSearch 本轮的实际执行结果（仅搜索功能开启且已执行预搜索时传入）。
    preSearchOutcome?: PreSearchTurnOutcome
  ): Promise<void> {
    // 是否需要搜索声明只由「用户是否开启搜索功能」与「历史 provenance」决定，与协议、
    // 用户提示词 / instructions、以及本轮是否拿到结果无关：
    //   - 搜索功能已开启（Tools / PreSearch 成功 / 0 结果 / 失败）：绝不注入关闭语义；
    //   - 已注入 history provenance：不注入，其能力说明已覆盖当前状态；
    //   - 其余（用户确实关闭搜索且无历史）：注入统一 NOTICE。
    const hasProvenanceContext = this.segmentHasSearchProvenance(segmentId)
    const includeNotice = shouldIncludeNoSearchNotice({
      searchEnabledThisTurn,
      hasProvenanceContext,
    })
    const noSearchInstructions = includeNotice ? (instructions ? instructions + '\n\n' + NO_SEARCH_CAPABILITY_NOTICE : NO_SEARCH_CAPABILITY_NOTICE) : instructions
    // Direct 路径本轮无 tools：skipWebSearchHistory=true。搜索功能开启时把「已执行预搜索」
    // 及其真实结果状态传入 request 构建，使 provenance / 开关说明按「搜索开启」而非「搜索关闭」表述。
    const request = this.buildCanonicalRequest(
      modelId, noSearchInstructions, segmentId, '', effort, adapter.protocol, true, effectiveResponsesLite,
      undefined, searchEnabledThisTurn, preSearchOutcome
    )
    await this.runGenerationDirectStream(conversationId, adapter, request, assistantMessageId, abortController)
  }

  // 使用已构造好的 request 执行流式生成（复用 runGenerationDirect 的流处理逻辑）
  private async runGenerationDirectStream(
    conversationId: string,
    adapter: ModelAdapter,
    request: CanonicalModelRequest,
    assistantMessageId: string,
    abortController: AbortController
  ): Promise<void> {
    let accumulatedContent = ''
    const citationBuf = new CitationStreamBuffer()
    let providerTurnId: string | null = null
    let reasoningStartedAt: number | null = null
    let totalReasoningDuration = 0
    let reasoningTextAccum = ''
    // 部分 Responses API 不支持 function calling，会以原始文本输出 <tool_call>，流式阶段需剥离
    let toolCallTextActive = false
    let toolCallTextBuffer = ''
    let finalized = false
    // 协议原生内容块 / usage / stop_reason（Anthropic 无损持久化；其它协议 adapter 不发送 → 保持 null）。
    const nativeBlocks: Array<Record<string, unknown>> = []
    let lastUsage: Record<string, unknown> | null = null
    let lastStopReason: string | null = null

    const persistProtocolMeta = (): void => {
      if (nativeBlocks.length > 0) {
        this.messages.updateProtocolBlocks(assistantMessageId, {
          protocol: adapter.protocol,
          modelId: request.model,
          blocks: nativeBlocks,
        })
      }
      if (lastUsage) this.messages.updateUsage(assistantMessageId, lastUsage)
      if (lastStopReason !== null) this.messages.updateStopReason(assistantMessageId, lastStopReason)
    }

    const sanitizeDelta = (rawText: string): string => {
      let out = ''
      let buf = toolCallTextBuffer
      let active = toolCallTextActive
      let i = 0
      const lower = rawText.toLowerCase()
      const startTag = '<tool_call>'
      const endTag = '</tool_call>'

      while (i < rawText.length) {
        if (!active) {
          const startIdx = lower.indexOf(startTag, i)
          if (startIdx === -1) {
            out += rawText.slice(i)
            break
          }
          out += rawText.slice(i, startIdx)
          active = true
          buf = ''
          i = startIdx + startTag.length
        } else {
          const endIdx = lower.indexOf(endTag, i)
          if (endIdx === -1) {
            buf += rawText.slice(i)
            i = rawText.length
            break
          }
          // 找到结束标签，丢弃整个 <tool_call> 块
          active = false
          buf = ''
          i = endIdx + endTag.length
        }
      }
      toolCallTextBuffer = buf
      toolCallTextActive = active
      return out
    }

    for await (const event of adapter.stream(request, abortController.signal)) {
      switch (event.type) {
        case 'delta': {
          const sanitized = sanitizeDelta(event.text)
          const cleanText = this.cleanDelta(citationBuf, sanitized)
          if (cleanText) {
            accumulatedContent += cleanText
            this.messages.updateContent(assistantMessageId, accumulatedContent)
            this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: cleanText })
          }
          break
        }

        case 'turn_started':
          providerTurnId = event.turnId ?? null
          if (providerTurnId) {
            this.messages.updateProviderIds(assistantMessageId, providerTurnId, '')
          }
          this.emitStreamEvent({ type: 'turn-started', conversationId, turnId: providerTurnId ?? '' })
          break

        case 'reasoning_started':
          reasoningStartedAt = Date.now()
          this.emitStreamEvent({ type: 'reasoning-started', conversationId, turnId: providerTurnId ?? '', itemId: event.itemId })
          break

        case 'reasoning_delta':
          reasoningTextAccum += event.text || ''
          this.messages.updateReasoningTextDebounced(assistantMessageId, reasoningTextAccum)
          this.emitStreamEvent({ type: 'reasoning-delta', conversationId, text: event.text })
          break

        case 'reasoning_completed': {
          const phaseDuration = reasoningStartedAt ? Date.now() - reasoningStartedAt : 0
          totalReasoningDuration += phaseDuration
          // 多阶段推理：累积 summary，不覆盖之前阶段的摘要
          const prevReasoning = this.messages.getById(assistantMessageId)?.reasoningMeta
          const accumulatedSummary = [...(prevReasoning?.summary ?? []), ...(event.summary ?? [])]
          const meta = {
            duration: totalReasoningDuration,
            effort: request.reasoningEffort || '',
            summary: accumulatedSummary,
            available: accumulatedSummary.length > 0,
          }
          this.messages.updateReasoningMeta(assistantMessageId, meta)
          this.emitStreamEvent({ type: 'reasoning-completed', conversationId, turnId: providerTurnId ?? '', itemId: event.itemId, reasoningMeta: meta })
          break
        }

        case 'native_block':
          // 协议原生块（Anthropic thinking / redacted_thinking / tool_use 等）无损收集。
          nativeBlocks.push(event.block as Record<string, unknown>)
          break

        case 'usage':
          lastUsage = event.usage.raw ?? null
          break

        case 'stop_reason':
          lastStopReason = event.reason
          break

        case 'turn_completed':
          // 刷新 citation 缓冲区残余
          {
            const directFlush = this.flushCitationBuffer(citationBuf)
            if (directFlush) {
              accumulatedContent += directFlush
              this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: directFlush })
            }
          }
          this.messages.updateContent(assistantMessageId, this.cleanFinalText(accumulatedContent))
          this.messages.flushReasoningText(assistantMessageId, reasoningTextAccum)
          persistProtocolMeta()
          this.messages.updateStatus(assistantMessageId, 'completed')
          this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
          finalized = true
          break

        case 'error':
          this.messages.updateError(assistantMessageId, event.code, event.message)
          this.emitStreamEvent({ type: 'error', conversationId, errorCode: event.code, errorMessage: event.message })
          finalized = true
          break
      }
    }

    // 流结束但未收到 turn_completed 或 error（被中断或异常结束）
    if (!finalized && this.activeGeneration?.assistantMessageId === assistantMessageId) {
      if (abortController.signal.aborted) {
        // 中断：保留已完成的原生块（中断时未完成的 tool JSON 不会出现在 native_block 中），
        // 但不伪造完整 thinking signature。
        persistProtocolMeta()
        this.messages.updateStatus(assistantMessageId, 'stopped')
        this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'interrupted' })
      } else {
        // 流异常终止：未收到 turn_completed 也未收到 error，且未被用户中断
        // 有内容则标记为 completed，否则报错，避免 UI 永远停留在 streaming 状态
        if (accumulatedContent.trim()) {
          const directFlush = this.flushCitationBuffer(citationBuf)
          if (directFlush) accumulatedContent += directFlush
          this.messages.updateContent(assistantMessageId, this.cleanFinalText(accumulatedContent))
          this.messages.flushReasoningText(assistantMessageId, reasoningTextAccum)
          persistProtocolMeta()
          this.messages.updateStatus(assistantMessageId, 'completed')
          this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
        } else {
          this.messages.updateError(assistantMessageId, 'StreamFailed', '响应流意外中断')
          this.emitStreamEvent({ type: 'error', conversationId, errorCode: 'StreamFailed', errorMessage: '响应流意外中断' })
        }
      }
    }
  }

  private buildCanonicalRequest(
    modelId: string,
    instructions: string,
    segmentId: string,
    userText: string,
    effort: string,
    targetProtocol?: ProviderProtocol,
    skipWebSearchHistory?: boolean,
    effectiveResponsesLite?: boolean,
    // 本轮归因分离（仅 Hosted）：当前用户消息已入库且会被历史循环读到，
    // 这里排除该条原始消息，并在尾部注入一次「实质问题」文本，避免模型看到归因要求。
    attribution?: { currentUserMessageId: string },
    // 本轮 OpenChat 搜索功能是否已开启（用户视角）。与 preSearchOutcome 一起区分：
    //   功能关闭 / 工具可用 / 已代为预搜索（成功·0结果·失败）。
    searchEnabledThisTurn?: boolean,
    // PreSearch 本轮的真实执行结果；仅当 searchEnabledThisTurn 且确实执行了预搜索时传入。
    preSearchOutcome?: PreSearchTurnOutcome
  ): CanonicalModelRequest {
    const segmentMessages = this.messages.getBySegmentId(segmentId)
    const messages: CanonicalMessage[] = []
    // 记录无法被目标协议原生重放的历史工具调用（折叠为只读历史记录，见下）。
    const readOnlyToolCalls: ReadOnlyHistoryToolCall[] = []

    // 失败重试去重（三协议共用）：某 user 的下一条是 failed assistant，且其后紧随的
    // user 与其等价（正文 + chat_input 图片一致）→ 旧 user 已被新一轮取代，跳过它。
    // 这是结构性证据，不是「文本相同即删除」：正常连续发送 / 两次都成功 / 内容不同 /
    // 附件不同 / 状态为 stopped·pending·streaming 等都不会触发。数据库记录不变。
    // 过滤旧 user（findSupersededUserMessageIds）与失败事实渲染（buildHistoricalFailureContext）
    // 共用同一判定算法 findSupersededRetries，绝不重复实现第二套重试判断。
    const supersededUserIds = findSupersededUserMessageIds(segmentMessages)

    for (const msg of segmentMessages) {
      if (msg.status !== 'completed') continue
      // 已被失败重试取代的 user 消息不进入模型输入（数据库与 UI 仍保留）。
      if (msg.role === 'user' && supersededUserIds.has(msg.id)) continue

      if (msg.role === 'user') {
        // 归因分离（仅 Hosted）：当前轮用户消息的原始文本含归因要求，不进入模型输入。
        // 但**附件必须保留**——用实质问题替换文本、沿用原附件，绝不丢图。
        const isAttributionSource = !!attribution && msg.id === attribution.currentUserMessageId
        // 历史图片附件每轮重新转换为 image input（三个 Provider 均为逐轮完整 replay）。
        // 仅取 chat_input，排除图片生成参考图/结果。
        const images = chatInputImages(msg)
        const textForModel = isAttributionSource ? userText : msg.content
        if (images.length > 0) {
          const parts: CanonicalInputPart[] = []
          if (textForModel) parts.push({ type: 'text', text: textForModel })
          for (const att of images) {
            parts.push({ type: 'image', attachmentId: att.id, detail: att.detail })
          }
          messages.push({ role: 'user', content: textForModel, inputParts: parts })
        } else if (textForModel) {
          messages.push({ role: 'user', content: textForModel })
        }
        continue
      }

      if (msg.role === 'assistant') {
        // 协议原生块重放：仅当历史消息与目标协议一致、且生成模型与当前模型一致时
        // 才原样重放（Anthropic thinking signature 绑定模型，跨模型重放会被拒签）。
        // 原生块包含 thinking / tool_use 等完整内容，与下方 canonical 重建互斥。
        if (targetProtocol === 'anthropic_messages' && msg.protocolBlocksJson) {
          try {
            const payload = JSON.parse(msg.protocolBlocksJson) as {
              protocol?: string
              modelId?: string | null
              blocks?: Array<Record<string, unknown>>
              transcript?: Array<{ role?: string; blocks?: Array<Record<string, unknown>> }>
            }
            const sameProtocol = payload.protocol === 'anthropic_messages'
            const sameModel = !payload.modelId || payload.modelId === modelId
            if (sameProtocol && sameModel) {
              const transcript = Array.isArray(payload.transcript)
                ? payload.transcript
                    .filter((it) => it && (it.role === 'user' || it.role === 'assistant') && Array.isArray(it.blocks) && it.blocks.length > 0)
                    .map((it) => ({ role: it.role as 'user' | 'assistant', blocks: it.blocks as Array<Record<string, unknown>> }))
                : []
              const blocks = Array.isArray(payload.blocks) && payload.blocks.length > 0 ? payload.blocks : []
              // 搜索关闭（skipWebSearchHistory）时与其它协议同规则：不重放历史工具调用。
              // 否则同一轮搜索会同时以 native tool_use/tool_result（messages）和 provenance（system）
              // 出现两次，且请求在未声明 tools 的情况下携带 tool_use 块，模型会据此误判「本轮又搜索了」。
              // 仅含 thinking / text 的纯回答轮不受影响，仍可无损重放。
              const allNativeBlocks = [...transcript.flatMap((it) => it.blocks), ...blocks] as Array<{ type?: string }>
              const hasToolBlocks = allNativeBlocks.some(
                (b) => b.type === 'tool_use' || b.type === 'tool_result'
              )
              const replayNative = (transcript.length > 0 || blocks.length > 0)
                && !(skipWebSearchHistory === true && hasToolBlocks)
              if (replayNative) {
                messages.push({
                  role: 'assistant',
                  content: msg.content || undefined,
                  nativeBlocks: blocks,
                  nativeBlocksProtocol: 'anthropic_messages',
                  nativeBlocksModelId: payload.modelId ?? modelId,
                  ...(transcript.length > 0 ? { nativeTranscript: transcript } : {}),
                })
                continue
              }
              // 否则落到下方 canonical 重建：跳过 provider history 解析后只保留正文文本。
            }
          } catch {
            // 解析失败：退回 canonical 重建
          }
        }

        // 解析 providerPayloadJson，按真实执行顺序重建 history
        let webSearchCalls: CanonicalWebSearchCall[] | undefined
        // 源 Provider / Protocol 身份（用于只读历史说明「历史工具来自哪个 Provider」）。
        let srcProvider: string | undefined
        let srcProtocol: string | undefined
        // 按原始顺序收集的 tool items（function_call + function_call_output 交替）
        const orderedToolItems: Array<{ type: 'function_call'; call_id: string; name: string; namespace?: string; arguments: string } | { type: 'function_call_output'; call_id: string; output: string }> = []

        if (msg.providerPayloadJson && !skipWebSearchHistory) {
          try {
            const payload = JSON.parse(msg.providerPayloadJson) as Record<string, unknown>
            srcProvider = typeof payload.provider === 'string' ? payload.provider : undefined
            srcProtocol = typeof payload.protocol === 'string' ? payload.protocol : undefined

            // V2 schema: { provider, protocol, items }
            if (payload.items && Array.isArray(payload.items)) {
              const v2 = payload as unknown as ProviderPayloadV2

              for (const item of v2.items) {
                if (item.type === 'web_search_call') {
                  if (targetProtocol === 'chatgpt_codex') {
                    if (!webSearchCalls) webSearchCalls = []
                    webSearchCalls.push({
                      id: item.id,
                      status: item.status,
                      action: item.action ? { ...item.action, type: item.action.type ?? 'search' } : { type: 'search' },
                    })
                  }
                } else if (item.type === 'function_call') {
                  orderedToolItems.push({
                    type: 'function_call',
                    call_id: item.call_id,
                    name: item.name,
                    namespace: item.namespace,
                    arguments: item.arguments,
                  })
                } else if (item.type === 'function_call_output') {
                  orderedToolItems.push({
                    type: 'function_call_output',
                    call_id: item.call_id,
                    output: item.output,
                  })
                }
              }

              if (webSearchCalls && webSearchCalls.length > 0) {
                console.log('[Provider History] restore assistantId=%s webSearchCalls=%d', msg.id.slice(0, 8), webSearchCalls.length)
              }
              if (orderedToolItems.length > 0) {
                console.log('[Provider History] restore assistantId=%s types=%s', msg.id.slice(0, 8), orderedToolItems.map(i => i.type).join(','))
              }
            } else if (payload.toolCalls && Array.isArray(payload.toolCalls)) {
              // Legacy schema: { toolCalls: [...] } — 转换为 function_call + function_call_output 对
              const calls = payload.toolCalls as Array<{ id: string; name: string; namespace?: string; arguments: string; output: string; isError: boolean }>
              for (const tc of calls) {
                orderedToolItems.push({
                  type: 'function_call',
                  call_id: tc.id,
                  name: tc.name,
                  namespace: tc.namespace,
                  arguments: tc.arguments,
                })
                if (tc.output) {
                  orderedToolItems.push({
                    type: 'function_call_output',
                    call_id: tc.id,
                    output: tc.output,
                  })
                }
              }
            } else if (payload.hostedSearchCalls && Array.isArray(payload.hostedSearchCalls)) {
              // Legacy schema: { hostedSearchCalls: [...] } — 转换为 webSearchCalls
              if (targetProtocol === 'chatgpt_codex') {
                const calls = payload.hostedSearchCalls as Array<{ title: string | null; url: string | null; snippet: string | null; sourceType?: string }>
                webSearchCalls = calls.map((_, idx) => ({
                  id: `legacy_hosted_${idx}`,
                  action: {
                    type: 'search',
                    sources: calls
                      .filter((r) => r.url)
                      .map((r) => ({
                        url: r.url ?? undefined,
                        title: r.title ?? undefined,
                        type: r.sourceType ?? undefined,
                        snippet: r.snippet ?? undefined,
                      })),
                  },
                }))
              }
            }
          } catch {
            // 忽略无法解析的 payload
          }
        }

        // 按真实时序重建 messages：
        // web_search_call → function_call → function_call_output → ... → assistant(final text)

        // 1. Hosted web_search_call
        if (webSearchCalls && webSearchCalls.length > 0) {
          messages.push({ role: 'assistant', webSearchCalls })
          console.log('[Provider History] load assistantId=%s webSearchCalls=%d sources=%s',
            msg.id.slice(0, 8), webSearchCalls.length,
            webSearchCalls.map(w => w.action?.sources?.length ?? 0).join(','))
        }

        // 2. 按原始顺序发射 function_call / function_call_output
        // 先按目标协议判定可移植性：只把目标 Provider 能理解的 native 工具调用重放为原生结构；
        // 其余（如 Codex standalone 的 run@web 重放给自定义 Provider）折叠为有界只读历史记录，
        // 且 function_call 与其 output 成对处理，绝不产生孤立的 role=tool 消息。
        const { portable, readOnlyCalls } = partitionToolHistoryByPortability(orderedToolItems, targetProtocol)
        // 合并源 Provider / Protocol 身份，供只读历史如实说明历史工具来源。
        if (readOnlyCalls.length > 0) {
          const enriched = readOnlyCalls.map((c) => ({
            ...c,
            sourceProvider: srcProvider,
            sourceProtocol: srcProtocol,
          }))
          readOnlyToolCalls.push(...enriched)
        }
        for (const item of portable) {
          if (item.type === 'function_call') {
            messages.push({
              role: 'assistant',
              toolCalls: [{
                id: item.call_id,
                name: item.name,
                namespace: item.namespace,
                arguments: item.arguments,
              }],
            })
          } else {
            // function_call_output
            messages.push({
              role: 'tool',
              content: item.output,
              toolResult: {
                callId: item.call_id,
                name: '',
                output: item.output,
              },
            })
          }
        }

        // 3. 最终 assistant 文本（在所有工具结果之后）
        if (msg.content) {
          messages.push({ role: 'assistant', content: msg.content })
        }
      }
    }

    // 注入所有历史搜索的确定性来源上下文（始终注入，即使当前请求不带 tools）
    // 确保模型记住自己执行过搜索，避免关闭搜索后模型否认之前的搜索结果
    // 通过 systemPrompt 携带（而非 mid-array developer message），避免 Chat Completions 协议
    // 将 developer 转成 system 后出现在消息中间被服务端拒绝（"System message must be at the beginning."）
    const allProvenances = resolveAllSearchProvenance(segmentMessages)
    // 本轮搜索模式（协议无关）：
    //   - 'tools'    ：本轮声明了搜索工具，模型可直接调用；
    //   - 'presearch'：搜索功能已开启，但本轮未声明工具（模型不能自行调用）；
    //   - 'disabled' ：用户确实关闭了搜索。
    // 关键：模式只由「用户是否开启搜索功能」决定，与本轮是否拿到结果、
    // 或模型是否判断无需搜索无关。'presearch' 绝不等于「搜索已关闭」。
    const currentSearchMode: SearchTurnMode =
      skipWebSearchHistory !== true
        ? 'tools'
        : (searchEnabledThisTurn === true ? 'presearch' : 'disabled')
    if (allProvenances.length > 0) {
      const ctx = buildAllProvenanceContext(allProvenances, currentSearchMode)
      instructions = instructions + '\n\n' + ctx
      console.log('[Search Provenance] count=%d modes=%s currentMode=%s', allProvenances.length, allProvenances.map((p) => p.mode).join(','), currentSearchMode)
    }

    // 本轮预搜索的真实结果说明（不属于历史 Provenance：它描述的是「本轮」）。
    // 仅在「搜索功能开启、无 tools、已代为预搜索」时注入；如实区分成功 / 0 结果 / 失败，
    // 绝不表述为「搜索已关闭」。（模型判定无需搜索时 preSearchOutcome=undefined，不注入此段。）
    if (currentSearchMode === 'presearch' && preSearchOutcome) {
      instructions = instructions + '\n\n' + buildPreSearchTurnNotice(preSearchOutcome)
    }

    // 历史失败事实：失败 assistant 会被历史重建过滤，导致模型不知道历史上发生过「请求失败 + 重发」。
    // 这里仅依据真实数据库记录（status=failed + 可解析的 HTTP 状态码 + 结构性重发证据）如实陈述，
    // 与 Search Provenance 完全独立（不计为搜索、不恢复被过滤的 user）。三协议共用同一注入点。
    // 无任何失败记录时 build 返回 ''，不追加任何提示。
    const failureContext = buildHistoricalFailureContext(segmentMessages)
    if (failureContext) {
      instructions = instructions + '\n\n' + failureContext
      console.log('[History Failures] injected')
    }

    // 不可移植的历史工具调用 → 有界只读历史记录（明确标注非当前可用工具，保留真实结果）。
    // 信任边界：arguments / output 可能含网页等外部来源的任意文本，属数据非指令。
    // 因此作为**低信任历史数据**插入 messages（一条纯文本 user 消息，紧随重建的历史之后、
    // 当前用户消息之前），绝不拼进 systemPrompt / developer / Codex 顶层 instructions。
    if (readOnlyToolCalls.length > 0) {
      const roContent = buildReadOnlyToolHistoryContent(readOnlyToolCalls)
      if (roContent) {
        messages.push({ role: 'user', content: roContent })
        console.log('[History Portability] target=%s readOnly=%d', targetProtocol ?? 'codex', readOnlyToolCalls.length)
      }
    }

    // 如果 userText 不在 messages 中，追加
    if (userText && !messages.some((m) => m.role === 'user' && m.content === userText)) {
      messages.push({ role: 'user', content: userText })
    }

    // 搜索开关状态切换提示：若本次请求的搜索能力与历史轮次不同，
    // 在 systemPrompt 中追加说明告知模型，避免它把能力变化误判为自己的失误
    // 仅当本轮确实「搜索关闭」时才提示开关变化；PreSearch（搜索开启、无 tools）不属于关闭。
    const currentlyDisabled = currentSearchMode === 'disabled'
    const hadSearchEnabled = this.detectSearchWasEnabledInHistory(segmentMessages)
    // 历史中是否出现过模型声称"没有搜索能力"的表述（曾因开关关闭而无法搜索）
    const historyContainsNoSearchClaim = segmentMessages.some(
      (m) => m.role === 'assistant' && /没有搜索|不能搜索|无法搜索|搜索功能|没有联网|无法联网|搜索.*关闭|关闭.*搜索|no search|can'?t search|cannot search/i.test(m.content)
    )

    // 本次关闭 + 历史开启过搜索 → 告知模型这是用户切换，不是它的失误
    // 同样折叠进 systemPrompt，避免 mid-array system message 触发服务端报错
    if (currentlyDisabled && hadSearchEnabled) {
      instructions = instructions + '\n\n' + 'NOTE: The user has just toggled web search OFF. In earlier turns you had web search tools, but for this turn they are gone. This is a user settings change, not a mistake on your part. Do NOT apologize, do NOT claim you "lied" or "made an error", and do NOT invent a self-contradictory explanation. Just answer using past search results or your own knowledge.'
    }

    // 本次开启 + 历史中出现过"不能搜索"的表述 → 告知模型搜索已恢复，别解释过去。
    // 仅在「工具可调用」时声称「又有搜索能力」；PreSearch 本轮不带 tools，模型无法直接调用，
    // 由预搜索上下文说明当前能力，绝不在此宣称可直接使用搜索工具。
    if (currentSearchMode === 'tools' && historyContainsNoSearchClaim) {
      instructions = instructions + '\n\n' + 'NOTE: Web search was toggled off in earlier turns (which is why the model previously said it could not search), but the user has now toggled it back ON. Do NOT apologize, do NOT explain past inconsistency, and do NOT dwell on previous turns. You now have web search available again — use it when needed.'
    }

    const dynamicParameters = this.resolveDynamicParametersForSegment(segmentId)

    return {
      model: modelId,
      systemPrompt: instructions,
      messages,
      attachmentResolver: this.attachmentResolver(),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(dynamicParameters ? { dynamicParameters } : {}),
      // Responses Lite 由 Transport Policy 决定（chatgpt_codex 路径）；自定义 Provider 无此 metadata → undefined。
      // effectiveResponsesLite 由调用方在 search strategy resolve 后计算并显式传入（如 codex-hosted 降级为 Non-Lite）；
      // 未显式传入时回落到模型 metadata（none / codex-standalone 均与 Policy 结果一致）。
      ...(targetProtocol === 'chatgpt_codex'
        ? { responsesLite: effectiveResponsesLite ?? this.modelService.getModelInfo(modelId)?.useResponsesLite }
        : {}),
    }
  }

  // 请求构建前的动态参数门禁（Main 权威层）。参数非法时抛出面向用户的错误，
  // 由 sendMessage 提前拦截。与 resolveDynamicParametersForSegment 共用同一套校验。
  private assertDynamicParametersValid(
    providerConfigId: string,
    modelId: string | null,
    values: RequestParameterValues
  ): void {
    const definitions = this.providerConfigService.getResolvedRequestParameters(providerConfigId, modelId)
    if (definitions.length === 0) return
    const protocol = this.providerConfigService.listSafe().find((p) => p.id === providerConfigId)?.protocol
    const { resolved, error } = resolveParameterValues(definitions, values, protocol)
    if (error) {
      logRequestParameterError(error)
      throw new Error(`参数设置无效：${error} 请检查「高级参数」设置。`)
    }
    // 运行期防御：动态参数重复 path / 撞协议保留字段 → 拦截，绝不 last-write-wins。
    const conflict = findDynamicParameterConflict(resolved, computeReservedRequestPaths(protocol ?? 'chat_completions'))
    if (conflict) {
      logRequestParameterError(conflict)
      throw new Error(`参数设置无效：${conflict} 请检查「高级参数」设置。`)
    }
  }

  // 解析当前会话的动态请求参数（Main 权威层）：从 Conversation 读取用户值，
  // 从当前 Provider Profile + Model 重新 resolve definitions，校验后返回。
  // 只对自定义 Provider（chat_completions / responses）生效；ChatGPT Codex 内建路径不注入
  // （Codex 是受控协议，其内建 Provider profile 恒为空，不给用户任意注入参数的能力）。
  // 返回 null 表示当前请求不携带动态参数（行为完全不变）。
  private resolveDynamicParametersForSegment(segmentId: string): ResolvedRequestParameter[] | null {
    const segment = this.segments.getById(segmentId)
    if (!segment) return null
    const conversation = this.conversations.getById(segment.conversationId)
    if (!conversation?.providerConfigId) return null

    const definitions = this.providerConfigService.getResolvedRequestParameters(
      conversation.providerConfigId,
      conversation.defaultModelId
    )
    if (definitions.length === 0) return null

    const protocol = this.providerConfigService.listSafe().find(
      (p) => p.id === conversation.providerConfigId
    )?.protocol
    const { resolved, error } = resolveParameterValues(
      definitions,
      conversation.requestParameterValues ?? {},
      protocol
    )
    if (error) {
      // 参数在前置校验（sendMessage）已拦截；此处为 defense-in-depth，静默不注入脏参数。
      console.error('[DynamicParameters] skipped: %s', error)
      return null
    }
    // 运行期防御：重复 path / 撞保留字段同样不注入（防止 DB 旧值 / 手改后残留）。
    const conflict = findDynamicParameterConflict(resolved, computeReservedRequestPaths(protocol ?? 'chat_completions'))
    if (conflict) {
      console.error('[DynamicParameters] skipped: %s', conflict)
      return null
    }
    return resolved.length > 0 ? resolved : null
  }

  // 由主进程提供的受控附件解析器：attachmentId → 受管文件路径信息。
  // Adapter 通过它按需读取图片字节，renderer 永不接触文件系统路径。
  private attachmentResolver(): AttachmentResolver | undefined {
    if (!this.attachmentService) return undefined
    return {
      resolveForProvider: (id) => this.attachmentService!.resolveForProvider(id),
    }
  }

  // 为 Responses 协议构建带 developer message 的请求（搜索上下文注入为 developer role）。
  //
  // 关键：PreSearch 降级路径同样必须获得与其它协议一致的应用级历史上下文——
  //   Provenance / 搜索开关说明 / 不可移植历史工具（只读）。
  // 因此这里直接复用 buildCanonicalRequest（skipWebSearchHistory=true, preSearch=true），
  // 再仅在本轮的 developer 搜索上下文处做协议专属的序列化（Responses 的 developer role
  // 优先级高于顶层 instructions）。绝不另建一套只遍历正文、会丢失历史事实的构建逻辑。
  private buildCanonicalRequestWithDeveloper(
    modelId: string,
    instructions: string,
    searchContext: string,
    segmentId: string,
    effort: string,
    targetProtocol?: ProviderProtocol,
    preSearchOutcome?: PreSearchTurnOutcome
  ): CanonicalModelRequest {
    // 搜索功能已开启且本轮已执行预搜索 → 'presearch'（而非 'disabled'），与是否拿到结果无关。
    const base = this.buildCanonicalRequest(
      modelId, instructions, segmentId, '', effort, targetProtocol ?? 'responses',
      true, undefined, undefined, true, preSearchOutcome
    )
    return {
      ...base,
      messages: [{ role: 'developer', content: searchContext }, ...base.messages],
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeGeneration) return

    const { abortController, assistantMessageId } = this.activeGeneration

    abortController?.abort()

    if (assistantMessageId) {
      this.messages.updateStatus(assistantMessageId, 'stopped')
    }
  }

  private deriveTitle(text: string): string {
    const trimmed = text.trim().replace(/\n/g, ' ')
    return trimmed.slice(0, TITLE_MAX_LENGTH) || '新对话'
  }

  private getLocalDate(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  async updateUseModelInstructions(id: string, useModelInstructions: boolean): Promise<void> {
    this.conversations.updateUseModelInstructions(id, useModelInstructions)
    await this.storage.save()
  }

  async updateWebSearchEnabled(id: string, webSearchEnabled: boolean): Promise<void> {
    this.conversations.updateWebSearchEnabled(id, webSearchEnabled)
    await this.storage.save()
  }

  async updateCodexSearchMode(id: string, mode: 'hosted' | 'standalone'): Promise<void> {
    this.conversations.updateCodexSearchMode(id, mode)
    await this.storage.save()
  }

  async updateSearchEngine(id: string, engine: 'bing' | 'baidu' | 'google'): Promise<void> {
    this.conversations.updateSearchEngine(id, engine)
    await this.storage.save()
  }

  updateWebSearchConfig(config: WebSearchConfig): void {
    this.webSearchConfig = config
    this.webSearchService.setMaxResults(config.maxResults)
  }

  async updateProviderConfig(id: string, providerConfigId: string | null): Promise<void> {
    const conversation = this.conversations.getById(id)
    if (!conversation) throw new Error('会话不存在')

    const isImageProvider = !!providerConfigId && this.providerConfigService.isImageGenerationProvider(providerConfigId)
    const hasMessages = this.messages.getByConversationId(id).length > 0

    const action = resolveProviderSwitch({
      currentType: conversation.type,
      nextIsImageProvider: isImageProvider,
      hasMessages,
    })

    // Provider 名称快照 + 新 Provider 的第一个模型名快照（供失效时展示历史绑定）
    const nextProvider = providerConfigId
      ? this.providerConfigService.listSafe().find((p) => p.id === providerConfigId) ?? null
      : null
    const nextProviderName = nextProvider?.name ?? null
    const nextModelName = nextProvider?.models?.[0] ?? conversation.modelNameSnapshot

    switch (action.kind) {
      case 'reject':
        throw new Error(action.reason)
      case 'update-provider':
        // 同类型内更换（或保持）Provider
        this.conversations.updateProviderConfigId(id, providerConfigId)
        this.conversations.updateBindingSnapshot(id, nextProviderName, nextModelName)
        // 图片生成会话：Provider 切换后按新 Profile 做参数 reconciliation，
        // 清除新 Provider 不支持 / 非法的遗留默认值（不强行替换为新 Profile 的默认值）。
        if (conversation.type === 'image_generation') {
          this.reconcileImageDefaultsForProvider(id, providerConfigId)
        }
        await this.storage.save()
        return
      case 'unlock-to-chat':
        // 空会话：image_generation → chat
        this.conversations.updateType(id, 'chat')
        this.conversations.updateProviderConfigId(id, providerConfigId)
        this.conversations.updateBindingSnapshot(id, nextProviderName, nextModelName)
        await this.storage.save()
        return
      case 'lock-image':
        // 空会话：chat → image_generation，从此锁定
        this.conversations.lockImageGeneration(id, providerConfigId)
        this.conversations.updateBindingSnapshot(id, nextProviderName, nextModelName)
        await this.storage.save()
        return
    }

    this.conversations.updateProviderConfigId(id, providerConfigId)
    // 切换到自定义服务时，清除可能残留的 Codex 推理等级，避免 400
    if (providerConfigId && !isImageProvider) {
      const adapter = this.providerConfigService.getAdapter(providerConfigId)
      if (!adapter.capabilities.reasoning) {
        this.conversations.updateEffort(id, '')
      }
    }
    await this.storage.save()
  }

  // 按目标 Provider 的 Profile 重算会话图片默认参数：
  // 逐个参数，新 Profile 仍合法则保留，否则清空为 null（Provider 默认），
  // 不强行替换成新 Profile 的第一个 option（避免用户没选就被改了值）。
  private reconcileImageDefaultsForProvider(id: string, providerConfigId: string | null): void {
    const conversation = this.conversations.getById(id)
    if (!conversation) return
    const profile = this.providerConfigService.getImageGenerationProfile(providerConfigId)
    const next = reconcileImageDefaults(profile, {
      size: conversation.defaultImageSize,
      quality: conversation.defaultImageQuality,
      background: conversation.defaultImageBackground,
    })
    if (
      next.size !== conversation.defaultImageSize ||
      next.quality !== conversation.defaultImageQuality ||
      next.background !== conversation.defaultImageBackground
    ) {
      this.conversations.updateImageDefaults(id, next.size, next.quality, next.background)
    }
  }
}