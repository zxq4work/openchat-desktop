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
import type { CanonicalMessage, CanonicalModelRequest, CanonicalToolCall } from '../../../shared/types/provider'
import { TITLE_MAX_LENGTH } from '../../../shared/constants'
import type { ChatGPTCodexClient, ProviderInputItem } from './transport/ChatGPTCodexClient'
import { UsageLimitReachedError } from './transport/ChatGPTCodexClient'
import type { ChatGPTModelService } from './models/ChatGPTModelService'
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

export interface StreamEvent {
  type: 'delta' | 'reasoning-started' | 'reasoning-delta' | 'reasoning-completed' | 'turn-started' | 'item-started' | 'item-completed' | 'turn-completed' | 'error' | 'web-search-started' | 'web-search-completed' | 'web-search-error' | 'stream-reset'
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
    this.toolRegistry = toolRegistry
    this.webSearchService = webSearchService
    this.providerConfigService = providerConfigService
    this.usageService = usageService
  }

  onStreamEvent(handler: (event: StreamEvent) => void): void {
    this.streamHandlers.push(handler)
  }

  private emitStreamEvent(event: StreamEvent): void {
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

  createConversation(defaultModelId: string | null, defaultReasoningEffort: string | null, systemPrompt = '', providerConfigId: string | null = null): Conversation {
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
      webSearchEnabled: false,
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
      conversation.webSearchEnabled
    )

    return { userMessage, assistantMessage }
  }

  private resolveAdapter(providerConfigId: string | null): ModelAdapter {
    if (providerConfigId) {
      return this.providerConfigService.getAdapter(providerConfigId)
    }
    return new ChatGPTCodexAdapter(this.codexClient)
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
    webSearchEnabled: boolean
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

      if (webSearchEnabled) {
        const cacheKey = this.buildCapabilityCacheKey(providerConfigId, adapter, modelId)
        const capability = this.toolCapabilityCache.get(cacheKey) ?? 'unknown'
        console.log('[Tool Capability] protocol=', adapter.protocol, 'model=', modelId, 'capability=', capability)

        // unsupported → 直接走 PreSearch
        if (capability === 'unsupported') {
          console.log('[Tool Decision] mode=presearch capability=', capability)
          await this.runGenerationWithPreSearch(
            conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, abortController
          )
        } else {
          // unknown / supported / nonstandard → 尝试 ToolLoop
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
              // 回退到 PreSearch
              await this.runGenerationWithPreSearch(
                conversationId, adapter, modelId, instructions, effort, assistantMessageId, userText, abortController
              )
              return
            } else {
              throw err
            }
          }
        }
      } else {
        await this.runGenerationDirect(
          conversationId, adapter, modelId, instructions, effort, assistantMessageId, segmentId, abortController
        )
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
    let providerTurnId: string | null = null
    let reasoningStartedAt: number | null = null
    let totalReasoningDuration = 0

    const controller = new ToolLoopController(adapter, this.toolRegistry)

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
          console.log('[WebSearch] search failed, callId=', callId, 'error=', errorOutput ?? 'unknown')
          this.emitStreamEvent({
            type: 'web-search-error',
            conversationId,
            toolCallId: callId,
          })
        }
      },
      onDelta: (text) => {
        accumulatedContent += text
        this.messages.updateContent(assistantMessageId, accumulatedContent)
        this.emitStreamEvent({ type: 'delta', conversationId, turnId: providerTurnId ?? '', text })
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
    const request = this.buildCanonicalRequest(modelId, fullInstructions, segmentId, userText, effort)

    console.log('[Generation] before ToolLoop.run')
    const result = await controller.run(request, abortController.signal, callbacks)
    console.log('[Generation] after ToolLoop.run finalTextLength=%d totalToolCalls=%d', result.finalText?.length ?? 0, result.totalToolCalls)

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

    console.log('[Generation] before updateContent, textLength=%d', result.finalText.length)
    this.messages.updateContent(assistantMessageId, result.finalText)
    console.log('[Generation] after updateContent')

    console.log('[Generation] before updateStatus')
    this.messages.updateStatus(assistantMessageId, 'completed')
    console.log('[Generation] after updateStatus')

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

    // 持久化工具调用历史，使模型在后续 turn 能感知已执行的搜索工具
    if (result.toolCallHistory.length > 0) {
      this.messages.updateProviderPayload(assistantMessageId, {
        toolCalls: result.toolCallHistory.map((entry) => ({
          id: entry.callId,
          name: entry.name,
          arguments: entry.arguments,
          output: entry.output,
          isError: entry.isError,
        })),
      })
    }

    console.log('[Generation] before turn-completed emit')
    this.emitStreamEvent({ type: 'turn-completed', conversationId, status: 'completed' })
    console.log('[Generation] after turn-completed emit')
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

    const searchQuery = await this.extractSearchQuery(adapter, modelId, userText, abortController)
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
      const segmentId = this.messages.getById(assistantMessageId)?.segmentId ?? ''
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
      console.log('[PreSearch] query=', searchQuery)
      console.log('[PreSearch] results count=', results.length)
      for (const r of results) {
        console.log(`[PreSearch]   [${r.index}] ${r.title}`)
        console.log(`[PreSearch]        url: ${r.url}`)
        console.log(`[PreSearch]        snippet: ${r.snippet}`)
      }
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
      this.emitStreamEvent({
        type: 'web-search-error',
        conversationId,
        toolCallId: 'pre-search',
      })
    }

    const segmentId = this.messages.getById(assistantMessageId)?.segmentId ?? ''

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

  // 判断是否需要搜索，是则提取 query；否则返回空字符串跳过搜索
  private async extractSearchQuery(
    adapter: ModelAdapter,
    modelId: string,
    userText: string,
    abortController: AbortController
  ): Promise<string> {
    const prompt = `Decide whether the following user message needs a web search.

If a web search IS needed, output the best search query on a single line.

If a web search is NOT needed, output only the word: NO_SEARCH

Do NOT think, reason, or explain. Output exactly one of:
- A search query (one line)
- NO_SEARCH

User message: ${userText}`
    const request: CanonicalModelRequest = {
      model: modelId,
      systemPrompt: 'You are a search decision assistant. Output only a search query or NO_SEARCH. No thinking, no reasoning, no explanation.',
      messages: [{ role: 'user', content: prompt }],
    }
    console.log('[PreSearch] extractQuery request:', JSON.stringify(request))
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
    console.log('[PreSearch] extractQuery response:', query)
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
      console.log('[PreSearch] extractQuery decision: NO_SEARCH')
      return ''
    }
    console.log('[PreSearch] extracted query=', cleaned.slice(0, 500))
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
    const request = this.buildCanonicalRequest(modelId, instructions, segmentId, '', effort)
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
          const cleanText = sanitizeDelta(event.text)
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
          this.messages.updateContent(assistantMessageId, accumulatedContent)
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
    effort: string
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
        const assistantMsg: CanonicalMessage = { role: 'assistant' }
        if (msg.content) {
          assistantMsg.content = msg.content
        }

        // 重建历史工具调用：让模型在后续 turn 感知已执行的 web 搜索
        let toolCallsFromPayload: Array<{ id: string; name: string; arguments: string; output: string; isError: boolean }> = []
        if (msg.providerPayloadJson) {
          try {
            const payload = JSON.parse(msg.providerPayloadJson) as {
              toolCalls?: Array<{ id: string; name: string; arguments: string; output: string; isError: boolean }>
            }
            if (payload.toolCalls && payload.toolCalls.length > 0) {
              assistantMsg.toolCalls = payload.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              }))
              toolCallsFromPayload = payload.toolCalls
            }
          } catch {
            // 忽略无法解析的 payload
          }
        }

        if (assistantMsg.content || assistantMsg.toolCalls) {
          messages.push(assistantMsg)
        }

        // 追加工具结果消息
        for (const tc of toolCallsFromPayload) {
          messages.push({
            role: 'tool',
            content: tc.output,
            toolResult: {
              callId: tc.id,
              name: tc.name,
              output: tc.output,
              isError: tc.isError,
            },
          })
        }
      }
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