import { randomUUID } from 'crypto'
import { ConversationRepository } from '../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../storage/MessageRepository'
import { StorageService } from '../../storage/StorageService'
import type {
  Conversation,
  ContextSegment,
  Message,
} from '../../../shared/types/conversation'
import type { CanonicalMessage, CanonicalModelRequest, CanonicalToolCall, CanonicalWebSearchCall, ProviderPayloadItem, ProviderPayloadV2, ProviderProtocol } from '../../../shared/types/provider'
import { TITLE_MAX_LENGTH } from '../../../shared/constants'
import type { ChatGPTCodexClient } from './transport/ChatGPTCodexClient'
import { UsageLimitReachedError } from './transport/ChatGPTCodexClient'
import type { ChatGPTModelService } from './models/ChatGPTModelService'
import { resolveAllSearchProvenance, buildAllProvenanceContext } from './search/SearchProvenanceResolver'
import { ToolLoopController } from '../../tools/ToolLoopController'
import type { ToolLoopCallbacks } from '../../tools/ToolLoopController'
import { ToolRegistry } from '../../tools/ToolRegistry'
import { WebSearchService } from '../../web-search/WebSearchService'
import { ProviderConfigService } from '../../providers/ProviderConfigService'
import { ChatGPTCodexAdapter } from '../../providers/ChatGPTCodexAdapter'
import type { ModelAdapter } from '../../../shared/types/provider'
import type { OAuthCredentialManager } from './auth/OAuthCredentialManager'
import { ChatGPTUsageService } from './usage/ChatGPTUsageService'
import { CodexUsageExhaustedError } from '../../../shared/types/usage'
import { hostnameFromUrl } from '../../../shared/utils/searchDisplay'
import { ChatGPTCodexStandaloneSearchClient } from './search/ChatGPTCodexStandaloneSearchClient'
import { CodexStandaloneWebRunTool } from './tools/CodexStandaloneWebRunTool'
import { cleanCitationText, CitationStreamBuffer } from '../../services/ai/CitationParser'
import { citationDebugTracker } from '../../services/ai/CitationDebugTracker'

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

// Codex 搜索模式语义判定规则（Hosted 和 Standalone 共用）
const CODEX_SEARCH_MODE_SEMANTICS = `<!-- CODEX_SEARCH_MODE_SEMANTICS_V1 -->
## Web Search Modes in OpenChat

There are THREE distinct web search mechanisms. They are NOT interchangeable. When asked "what tool did you use" or "what search mode was used", identify the correct one from the conversation history items — NOT from the current instructions or current search mode.

### 1. Hosted Web Search (provider-native)
- History item type: \`web_search_call\` with \`action.type\` (e.g. \`search\`)
- Executed server-side by the Codex backend. NOT a client function tool.
- Do NOT call it \`web.run\`. Do NOT call it "Standalone" or a "function tool".
- \`action.sources\` may contain:
  - \`{ type: "url", url, title }\` — ordinary web page source
  - \`{ type: "api", name: "oai-weather" }\` — built-in API data source (e.g. weather)
- Both are still Hosted Web Search. An \`api\` source does NOT mean a separate "weather tool" was called; it means Hosted Search used an internal API data source. Describe it as: "Hosted Web Search used the built-in oai-weather data source."

### 2. Standalone Web Search (web.run)
- History item type: \`function_call\` with \`namespace: "web"\` and \`name: "run"\`, paired with a corresponding \`function_call_output\`
- Client-side tool executed via /backend-api/codex/alpha/search. Often referred to as \`web.run\` or Standalone Web Search.
- This is NEVER Hosted Web Search. Do NOT call it "Hosted", "hosted search", "本地搜索", or "local search".
- If the history contains \`{ type: "function_call", name: "run", namespace: "web" }\` + \`function_call_output\`, the search was Standalone — regardless of what the current instructions say about "web_search" or "Hosted".

### 3. OpenChat Custom Web Search
- History item type: \`function_call\` with \`name: "openchat_web_search"\` (no namespace)
- Client-side tool used by non-Codex custom providers.

## Rules for answering "what tool/mode did you use"

You MUST determine the search mode from the ACTUAL history item type in the conversation input. Do NOT guess from:
- the result content (web pages, weather data, news, etc. do NOT determine the mode)
- the current instructions (they describe the CURRENT session's tool, not the HISTORY)
- the current SearchMode (it applies to this turn only, not to previous turns)

Strict mapping:
- \`type: web_search_call\` → answer "Hosted Web Search". Do NOT answer \`web.run\`, "Standalone", or "function tool".
- \`type: function_call\` with \`namespace=web, name=run\` + \`function_call_output\` → answer "Standalone Web Search (web.run)". Do NOT answer "Hosted" or "hosted search".
- \`type: function_call\` with \`name=openchat_web_search\` → answer "OpenChat Custom Web Search".

## Most recent search takes priority

When the user asks about "刚才", "上一次", "刚刚", "the previous search", or "what search was used", identify the MOST RECENT completed search tool call in the conversation history.

- Most recent \`web_search_call\` → Hosted Web Search
- Most recent \`function_call(namespace=web, name=run)\` + \`function_call_output\` → Standalone Web Search

Do NOT classify an older search event when a newer completed search exists. For example, if the history contains both an earlier Hosted \`web_search_call\` and a later Standalone \`function_call web.run\`, and the user asks "刚才用了什么", the answer is Standalone — because that is the most recent search.

Examples:
- History item \`{ "type": "web_search_call", "action": { "type": "search" } }\` → This was Hosted Web Search
- History item \`{ "type": "function_call", "name": "run", "namespace": "web" }\` + \`{ "type": "function_call_output" }\` → This was Standalone Web Search (web.run)`

const CODEX_SEARCH_INSTRUCTIONS = `You have access to web search via the Hosted web_search tool. This describes your CURRENT capability for this turn.

When you truly need external or up-to-date information, you may call web_search.
If the existing conversation context is sufficient to answer, answer directly without searching again.

Use web_search when:
- the user explicitly asks to search, browse, look up, find or verify information;
- the answer depends on current or potentially changed information;
- external verification would materially improve accuracy.

Use openchat_web_fetch when a search result snippet is insufficient and you need details from a source.

Prefer concise search queries.
Prefer primary and authoritative sources when possible.
Never claim that you searched the web unless a web tool was actually executed.
When using web results, cite relevant source URLs in the final answer.

` + CODEX_SEARCH_MODE_SEMANTICS

// Standalone 搜索指令：web.run 通过 additional_tools 声明，模型自主决定是否调用
const CODEX_STANDALONE_SEARCH_INSTRUCTIONS = `You have access to web search via the web.run tool (namespace: web, name: run). This describes your CURRENT capability for this turn.

When you truly need external or up-to-date information, you may call web.run.
If the existing conversation context is sufficient to answer, answer directly without searching again.

Use web.run when:
- the user explicitly asks to search, browse, look up, find or verify information;
- the answer depends on current or potentially changed information;
- external verification would materially improve accuracy.

Prefer concise search queries.
Prefer primary and authoritative sources when possible.
Never claim that you searched the web unless a web tool was actually executed.
When using web results, cite relevant source URLs in the final answer.

` + CODEX_SEARCH_MODE_SEMANTICS

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
}

type ToolCapability = 'unknown' | 'supported' | 'unsupported' | 'nonstandard'

export class ChatGPTConversationService {
  private conversations: ConversationRepository
  private segments: ContextSegmentRepository
  private messages: MessageRepository
  private storage: StorageService
  private codexClient: ChatGPTCodexClient
  private modelService: ChatGPTModelService
  private standaloneSearchClient: ChatGPTCodexStandaloneSearchClient
  private toolRegistry: ToolRegistry
  private webSearchService: WebSearchService
  private providerConfigService: ProviderConfigService
  private usageService: ChatGPTUsageService

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
    providerConfigService: ProviderConfigService
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
  }

  onStreamEvent(handler: (event: StreamEvent) => void): void {
    this.streamHandlers.push(handler)
  }

  private emitStreamEvent(event: StreamEvent): void {
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
      title: s.title,
      systemPrompt: '',
      systemPromptRevision: 0,
      defaultModelId: null,
      defaultReasoningEffort: null,
      currentSegmentId: '',
      useModelInstructions: true,
      webSearchEnabled: false,
      codexSearchMode: 'hosted',
      providerConfigId: null,
      createdAt: 0,
      updatedAt: s.updatedAt,
      }))
  }

  getConversation(id: string): {
    conversation: Conversation
    segments: ContextSegment[]
    messages: Message[]
  } | null {
    const conversation = this.conversations.getById(id)
    if (!conversation) return null

    const segments = this.segments.getByConversationId(id)
    const messages = this.messages.getByConversationId(id)

    return { conversation, segments, messages }
  }

  createConversation(defaultModelId: string | null, defaultReasoningEffort: string | null, systemPrompt = '', providerConfigId: string | null = null, webSearchEnabled = false): Conversation {
    const now = Date.now()
    const conversationId = randomUUID()
    const segmentId = randomUUID()

    const conversation: Conversation = {
      id: conversationId,
      title: '新对话',
      systemPrompt,
      systemPromptRevision: 0,
      defaultModelId,
      defaultReasoningEffort,
      currentSegmentId: segmentId,
      useModelInstructions: true,
      webSearchEnabled,
      codexSearchMode: 'hosted',
      providerConfigId,
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
    this.conversations.remove(id)
    await this.storage.save()
  }

  async removeAllConversations(): Promise<void> {
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

  async updateModel(id: string, modelId: string): Promise<void> {
    this.conversations.updateModel(id, modelId)
    await this.storage.save()
  }

  async updateEffort(id: string, effort: string): Promise<void> {
    this.conversations.updateEffort(id, effort)
    await this.storage.save()
  }

  newTopic(id: string): ContextSegment | null {
    const conversation = this.conversations.getById(id)
    if (!conversation) return null

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

  async sendMessage(conversationId: string, text: string): Promise<{ userMessage: Message; assistantMessage: Message }> {
    console.log('[SendMessage] entry conversationId=%s activeGeneration=%s', conversationId, this.activeGeneration ? `set(conv=${this.activeGeneration.conversationId})` : 'null')
    if (this.activeGeneration) {
      console.log('[SendMessage] BLOCKED: activeGeneration still set')
      throw new Error('已有正在进行的生成')
    }

    const conversation = this.conversations.getById(conversationId)
    if (!conversation) { console.log('[SendMessage] FAIL: conversation not found'); throw new Error('会话不存在') }

    const segment = this.segments.getById(conversation.currentSegmentId)
    if (!segment) { console.log('[SendMessage] FAIL: segment not found currentSegmentId=%s', conversation.currentSegmentId); throw new Error('当前上下文段不存在') }

    const modelId = conversation.defaultModelId
    if (!modelId) { console.log('[SendMessage] FAIL: no modelId'); throw new Error('未选择模型，请先刷新模型列表') }

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
      reasoningMeta: null,
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
      reasoningMeta: null,
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
      conversation.codexSearchMode
    )

    return { userMessage, assistantMessage }
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
    codexSearchMode: 'hosted' | 'standalone'
  ): Promise<void> {
    console.log('[runGeneration] entry conversationId=%s modelId=%s providerConfigId=%s webSearch=%s', conversationId, modelId, providerConfigId ?? 'codex', webSearchEnabled)
    try {
      const adapter = this.resolveAdapter(providerConfigId)

      const modelInstructions = useModelInstructions
        ? (this.modelService.getInstructionsTemplate(modelId) ?? '')
        : ''
      const conversationSystemPrompt = systemPrompt.trim()
        ? systemPrompt
        : 'You are a helpful assistant.'
      const baseMetadata = [
        `Current model: ${modelId}`,
        `Current date: ${this.getLocalDate()}`,
        `Current timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        'Additional info for this conversation:',
        '',
        conversationSystemPrompt,
      ].join('\n')

      const instructions = modelInstructions
        ? `${modelInstructions}\n\n${baseMetadata}`
        : baseMetadata

      this.messages.updateStatus(assistantMessageId, 'streaming')

      const segmentId = this.messages.getById(assistantMessageId)?.segmentId ?? ''

      const searchStrategy = this.resolveSearchStrategy(providerConfigId, webSearchEnabled, codexSearchMode)
      const engineLabel = searchStrategy === 'codex-hosted'
        ? 'codex-hosted'
        : searchStrategy === 'codex-standalone'
          ? 'codex-standalone'
          : searchStrategy === 'openchat-custom'
            ? (this.webSearchService.getEngineName())
            : 'none'
      console.log('[Search Strategy] provider=%s strategy=%s engine=%s', providerConfigId ?? 'codex', searchStrategy, engineLabel)

      switch (searchStrategy) {
        case 'codex-hosted':
          await this.runGenerationWithCodexHostedSearch(
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, segmentId, abortController
          )
          break

        case 'codex-standalone':
          await this.runGenerationWithCodexStandaloneSearch(
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, segmentId, abortController
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
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, segmentId, abortController
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
      } else {
        const code = err instanceof UsageLimitReachedError ? 'CODEX_USAGE_EXHAUSTED' : 'StreamFailed'
        this.messages.updateError(assistantMessageId, code, message)
        this.emitStreamEvent({ type: 'error', conversationId, errorCode: code, errorMessage: message })
      }
    } finally {
      console.log('[runGeneration] FINALLY: assistantMessageId=%s activeGenerationAssistantMessageId=%s', assistantMessageId, this.activeGeneration?.assistantMessageId ?? 'null')
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

    const controller = new ToolLoopController(adapter, this.toolRegistry, undefined, { signal: abortController.signal, conversationId, segmentId, modelId })

    const callbacks: ToolLoopCallbacks = {
      onToolCall: (toolCall: CanonicalToolCall) => {
        this.emitStreamEvent({
          type: 'web-search-started',
          conversationId,
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          toolCallArgs: toolCall.arguments,
        })
      },
      onToolResult: (callId, toolName, success, rawResults, errorOutput) => {
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
          // 超限/重复查询是护栏拦截，不是真正的搜索失败，不提示用户
          if (errorOutput && (errorOutput.includes('TOOL_LIMIT_EXCEEDED') || errorOutput.includes('DUPLICATE_QUERY'))) {
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
    // 按真实执行顺序保存 function_call + function_call_output 配对
    const completeToolHistoryCustom = result.toolCallHistory.filter((entry) => entry.output)
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

  // Codex Hosted Search：使用官方 web_search 工具，服务端执行搜索，单次 SSE 流
  private async runGenerationWithCodexHostedSearch(
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
    const webSearchResults: Array<{ title: string | null; url: string | null; snippet: string | null; sourceType?: 'web' | 'api' }> = []
    const webSearchCallItems: Array<{ id: string; status?: string; action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string; sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> } }> = []

    const fullInstructions = instructions + '\n\n' + CODEX_SEARCH_INSTRUCTIONS
    const semIdx = fullInstructions.indexOf('CODEX_SEARCH_MODE_SEMANTICS_V1')
    console.log('[Codex Search Semantics] mode=hosted snippet=%s', semIdx >= 0 ? fullInstructions.slice(semIdx, semIdx + 200) : 'NOT_FOUND')
    const request = this.buildCanonicalRequest(modelId, fullInstructions, segmentId, userText, effort, adapter.protocol)
    request.tools = [{
      name: 'web_search',
      description: '',
      parameters: {},
      toolType: 'web_search',
    }]
    request.toolChoice = 'auto'

    console.log('[Codex] runGenerationWithCodexHostedSearch model=%s conversationId=%s', modelId, conversationId)

    try {
      for await (const event of adapter.stream(request, abortController.signal)) {
        if (abortController.signal.aborted) break

        switch (event.type) {
          case 'delta': {
            const cleanText = this.cleanDelta(citationBuf, event.text)
            if (!cleanText) break
            accumulatedContent += cleanText
            this.messages.updateContent(assistantMessageId, accumulatedContent)
            this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: cleanText })
            break
          }

          case 'turn_started':
            if (event.turnId && !providerTurnId) {
              providerTurnId = event.turnId
              this.messages.updateProviderIds(assistantMessageId, event.turnId, '')
            }
            this.emitStreamEvent({ type: 'turn-started', conversationId, turnId: event.turnId ?? '' })
            break

          case 'reasoning_started':
            reasoningStartedAt = Date.now()
            this.emitStreamEvent({ type: 'reasoning-started', conversationId, turnId: providerTurnId ?? '', itemId: event.itemId })
            break

          case 'reasoning_delta':
            this.emitStreamEvent({ type: 'reasoning-delta', conversationId, text: event.text })
            break

          case 'reasoning_completed': {
            const phaseDuration = reasoningStartedAt ? Date.now() - reasoningStartedAt : 0
            totalReasoningDuration += phaseDuration
            const prevReasoning = this.messages.getById(assistantMessageId)?.reasoningMeta
            const accumulatedSummary = [...(prevReasoning?.summary ?? []), ...(event.summary ?? [])]
            const meta = {
              duration: totalReasoningDuration,
              effort: effort || '',
              summary: accumulatedSummary,
              available: accumulatedSummary.length > 0,
            }
            this.messages.updateReasoningMeta(assistantMessageId, meta)
            this.emitStreamEvent({ type: 'reasoning-completed', conversationId, turnId: providerTurnId ?? '', itemId: event.itemId, reasoningMeta: meta })
            break
          }

          case 'web_search_call':
            switch (event.phase) {
              case 'started':
                console.log('[Codex] web_search_call phase=started')
                this.emitStreamEvent({ type: 'web-search-call-started', conversationId })
                break
              case 'searching':
                break
              case 'completed':
                console.log('[Codex] web_search_call phase=completed itemId=', event.itemId ?? '(none)', 'resultsCount=', event.results?.length ?? 0)
                // 持久化 provider-native web_search_call item（用于跨 turn 模型记忆）
                if (event.itemId) {
                  webSearchCallItems.push({
                    id: event.itemId,
                    status: event.status,
                    action: event.action ?? { type: 'search' },
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
                this.emitStreamEvent({ type: 'web-search-call-completed', conversationId, webSearchResults })
                console.log('[Codex] web_search_call emitted webSearchResults count=', webSearchResults.length, 'first=', webSearchResults[0] ? JSON.stringify(webSearchResults[0]) : '(empty)')
                break
              case 'failed':
                console.log('[Codex] web_search_call phase=failed')
                this.emitStreamEvent({ type: 'web-search-call-failed', conversationId })
                break
            }
            break

          case 'turn_completed':
            break

          case 'error':
            this.messages.updateError(assistantMessageId, event.code, event.message)
            this.emitStreamEvent({ type: 'error', conversationId, errorCode: event.code, errorMessage: event.message })
            return
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return
      }
      throw err
    }

    const hostedFlushText = this.flushCitationBuffer(citationBuf)
    if (hostedFlushText) {
      accumulatedContent += hostedFlushText
      this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text: hostedFlushText })
    }
    this.messages.updateContent(assistantMessageId, this.cleanFinalText(accumulatedContent))
    this.messages.updateStatus(assistantMessageId, 'completed')

    if (webSearchResults.length > 0) {
      this.messages.updateWebSearchResults(assistantMessageId, webSearchResults)
    }

    // 持久化 provider-native tool history（V2 schema）
    if (webSearchCallItems.length > 0) {
      this.messages.updateProviderPayload(assistantMessageId, {
        provider: 'chatgpt_codex',
        protocol: 'chatgpt_codex',
        items: webSearchCallItems.map((i) => ({ type: 'web_search_call' as const, id: i.id, status: i.status, action: i.action })),
      })
      for (const i of webSearchCallItems) {
        console.log('[Hosted Replay Probe] persisted=', JSON.stringify({ id: i.id, status: i.status, action: i.action }))
      }
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
    abortController: AbortController
  ): Promise<void> {
    let accumulatedContent = ''
    const citationBuf = new CitationStreamBuffer()
    let providerTurnId: string | null = null
    let reasoningStartedAt: number | null = null
    let totalReasoningDuration = 0

    // 先构建 canonical request 以获取对话历史，传给 web.run 工具
    const standaloneInstructions = instructions + '\n\n' + CODEX_STANDALONE_SEARCH_INSTRUCTIONS
    const semIdx2 = standaloneInstructions.indexOf('CODEX_SEARCH_MODE_SEMANTICS_V1')
    console.log('[Codex Search Semantics] mode=standalone snippet=%s', semIdx2 >= 0 ? standaloneInstructions.slice(semIdx2, semIdx2 + 200) : 'NOT_FOUND')
    const request = this.buildCanonicalRequest(modelId, standaloneInstructions, segmentId, userText, effort, adapter.protocol)

    // 构建 web.run 工具注册表
    const standaloneToolRegistry = new ToolRegistry()
    const webRunTool = new CodexStandaloneWebRunTool(
      this.standaloneSearchClient,
      modelId,
      segmentId,
      request.messages
    )
    standaloneToolRegistry.register('run', webRunTool)

    const controller = new ToolLoopController(adapter, standaloneToolRegistry, undefined, { signal: abortController.signal, conversationId, segmentId, modelId })

    const callbacks: ToolLoopCallbacks = {
      onToolCall: (toolCall: CanonicalToolCall) => {
        this.emitStreamEvent({
          type: 'web-search-started',
          conversationId,
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          toolCallArgs: toolCall.arguments,
        })
      },
      onToolResult: (callId, toolName, success, rawResults) => {
        if (toolName === 'run') {
          if (success) {
            this.emitStreamEvent({
              type: 'web-search-completed',
              conversationId,
              toolCallId: callId,
              webSearchResults: rawResults,
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
    this.messages.updateStatus(assistantMessageId, 'completed')

    // 持久化搜索结果
    if (result.toolCallHistory.length > 0) {
      const allResults: Array<{ title: string | null; url: string | null; snippet: string | null; sourceType?: 'web' | 'api' }> = []
      for (const entry of result.toolCallHistory) {
        if (entry.name !== 'run') continue
        for (const item of entry.rawResults) {
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>
            allResults.push({
              title: (typeof obj.title === 'string' ? obj.title : null) ?? (typeof obj.name === 'string' ? obj.name : null),
              url: (typeof obj.url === 'string' ? obj.url : null) ?? (typeof obj.link === 'string' ? obj.link : null),
              snippet: (typeof obj.snippet === 'string' ? obj.snippet : null) ?? (typeof obj.description === 'string' ? obj.description : null),
              sourceType: 'web',
            })
          }
        }
      }
      if (allResults.length > 0) {
        this.messages.updateWebSearchResults(assistantMessageId, allResults)
      }
    }

    // 持久化 provider-native tool history（V2 schema）
    // 按真实执行顺序保存 function_call + function_call_output 配对
    // 只保存有合法 output 的完整 pair（error output 也算合法）
    const completeToolHistory = result.toolCallHistory.filter((entry) => entry.output)
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
      await this.runGenerationDirect(
        conversationId, adapter, modelId, instructions, effort, assistantMessageId, segmentId, abortController
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
    try {
      const results = await this.webSearchService.search(searchQuery, abortController.signal)
      console.log('[PreSearch] query=', searchQuery, 'results count=', results.length)
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

    // Responses 协议优先使用 developer message 注入搜索上下文
    if (searchContext && adapter.protocol === 'responses') {
      const request = this.buildCanonicalRequestWithDeveloper(
        modelId, instructions, searchContext, segmentId, effort
      )
      await this.runGenerationDirectStream(
        conversationId, adapter, request, assistantMessageId, abortController
      )
      return
    }

    const fullInstructions = searchContext
      ? instructions + '\n\n' + searchContext
      : instructions

    await this.runGenerationDirect(
      conversationId, adapter, modelId, fullInstructions, effort, assistantMessageId, segmentId, abortController
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
    abortController: AbortController
  ): Promise<void> {
    const request = this.buildCanonicalRequest(modelId, instructions, segmentId, '', effort, adapter.protocol)
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
    // 部分 Responses API 不支持 function calling，会以原始文本输出 <tool_call>，流式阶段需剥离
    let toolCallTextActive = false
    let toolCallTextBuffer = ''

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
          this.messages.updateStatus(assistantMessageId, 'completed')
          this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
          break

        case 'error':
          this.messages.updateError(assistantMessageId, event.code, event.message)
          this.emitStreamEvent({ type: 'error', conversationId, errorCode: event.code, errorMessage: event.message })
          break
      }
    }

    // 流结束但未收到 turn_completed（被中断或异常结束）
    if (this.activeGeneration?.assistantMessageId === assistantMessageId) {
      if (abortController.signal.aborted) {
        this.messages.updateStatus(assistantMessageId, 'stopped')
        this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'interrupted' })
      }
    }
  }

  private buildCanonicalRequest(
    modelId: string,
    instructions: string,
    segmentId: string,
    userText: string,
    effort: string,
    targetProtocol?: ProviderProtocol
  ): CanonicalModelRequest {
    const segmentMessages = this.messages.getBySegmentId(segmentId)
    const messages: CanonicalMessage[] = []

    for (const msg of segmentMessages) {
      if (msg.status !== 'completed') continue

      if (msg.role === 'user') {
        if (msg.content) {
          messages.push({ role: 'user', content: msg.content })
        }
        continue
      }

      if (msg.role === 'assistant') {
        // 解析 providerPayloadJson，按真实执行顺序重建 history
        let webSearchCalls: CanonicalWebSearchCall[] | undefined
        // 按原始顺序收集的 tool items（function_call + function_call_output 交替）
        const orderedToolItems: Array<{ type: 'function_call'; call_id: string; name: string; namespace?: string; arguments: string } | { type: 'function_call_output'; call_id: string; output: string }> = []

        if (msg.providerPayloadJson) {
          try {
            const payload = JSON.parse(msg.providerPayloadJson) as Record<string, unknown>

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
                for (const i of webSearchCalls) {
                  console.log('[Hosted Replay Probe] restored=', JSON.stringify({ id: i.id, status: i.status, action: i.action }))
                }
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
        for (const item of orderedToolItems) {
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

    // 注入所有历史搜索的确定性来源上下文
    const allProvenances = resolveAllSearchProvenance(segmentMessages)
    if (allProvenances.length > 0) {
      const ctx = buildAllProvenanceContext(allProvenances)
      messages.push({ role: 'developer', content: ctx })
      console.log('[Search Provenance] count=%d modes=%s', allProvenances.length, allProvenances.map((p) => p.mode).join(','))
    }

    // 如果 userText 不在 messages 中，追加
    if (userText && !messages.some((m) => m.role === 'user' && m.content === userText)) {
      messages.push({ role: 'user', content: userText })
    }

    return {
      model: modelId,
      systemPrompt: instructions,
      messages,
      ...(effort ? { reasoningEffort: effort } : {}),
    }
  }

  // 为 Responses 协议构建带 developer message 的请求（搜索上下文注入为 developer role）
  private buildCanonicalRequestWithDeveloper(
    modelId: string,
    instructions: string,
    searchContext: string,
    segmentId: string,
    effort: string
  ): CanonicalModelRequest {
    const segmentMessages = this.messages.getBySegmentId(segmentId)
    const messages: CanonicalMessage[] = []

    // 搜索上下文作为 developer message 注入（Responses API 优先级高于 system）
    messages.push({ role: 'developer', content: searchContext })

    for (const msg of segmentMessages) {
      if (msg.status !== 'completed') continue
      if (msg.role === 'user') {
        if (msg.content) messages.push({ role: 'user', content: msg.content })
        continue
      }
      if (msg.role === 'assistant') {
        const assistantMsg: CanonicalMessage = { role: 'assistant' }
        if (msg.content) assistantMsg.content = msg.content
        if (assistantMsg.content) messages.push(assistantMsg)
      }
    }

    return {
      model: modelId,
      systemPrompt: instructions,
      messages,
      ...(effort ? { reasoningEffort: effort } : {}),
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

  async updateProviderConfig(id: string, providerConfigId: string | null): Promise<void> {
    this.conversations.updateProviderConfigId(id, providerConfigId)
    // 切换到自定义服务时，清除可能残留的 Codex 推理等级，避免 400
    if (providerConfigId) {
      const adapter = this.providerConfigService.getAdapter(providerConfigId)
      if (!adapter.capabilities.reasoning) {
        this.conversations.updateEffort(id, '')
      }
    }
    await this.storage.save()
  }
}