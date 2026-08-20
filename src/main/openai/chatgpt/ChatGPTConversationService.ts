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
import { TITLE_MAX_LENGTH } from '../../../shared/constants'
import type { ChatGPTCodexClient } from './transport/ChatGPTCodexClient'
import type { ChatGPTModelService } from './models/ChatGPTModelService'

export interface StreamEvent {
  type: 'delta' | 'reasoning-started' | 'reasoning-completed' | 'turn-started' | 'item-started' | 'item-completed' | 'turn-completed' | 'error'
  turnId?: string
  itemId?: string
  text?: string
  status?: string
  errorCode?: string
  errorMessage?: string
  reasoningMeta?: import('../../../shared/types/conversation').ReasoningMeta
}

export class ChatGPTConversationService {
  private conversations: ConversationRepository
  private segments: ContextSegmentRepository
  private messages: MessageRepository
  private storage: StorageService
  private codexClient: ChatGPTCodexClient
  private modelService: ChatGPTModelService

  // 全局只允许一个 active generation
  private activeGeneration: {
    conversationId: string
    assistantMessageId: string | null
    abortController: AbortController | null
  } | null = null

  private streamHandlers: Array<(event: StreamEvent) => void> = []

  constructor(
    storage: StorageService,
    codexClient: ChatGPTCodexClient,
    modelService: ChatGPTModelService
  ) {
    this.storage = storage
    this.conversations = new ConversationRepository(storage)
    this.segments = new ContextSegmentRepository(storage)
    this.messages = new MessageRepository(storage)
    this.codexClient = codexClient
    this.modelService = modelService
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

  createConversation(defaultModelId: string | null, defaultReasoningEffort: string | null, systemPrompt = ''): Conversation {
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
    // Direct provider 无远端 thread 需要清理，仅本地删除
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

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (this.activeGeneration) {
      throw new Error('已有正在进行的生成')
    }

    const conversation = this.conversations.getById(conversationId)
    if (!conversation) throw new Error('会话不存在')

    const segment = this.segments.getById(conversation.currentSegmentId)
    if (!segment) throw new Error('当前上下文段不存在')

    const modelId = conversation.defaultModelId
    if (!modelId) throw new Error('未选择模型，请先刷新模型列表')

    let effort = conversation.defaultReasoningEffort
    // 防御性处理：如果 DB 中存储了损坏的 [object Object]
    if (effort && effort.includes('[object Object]')) {
      effort = null
    }

    const effortValue = effort ?? ''

    // 构造请求 input（当前 segment 的历史消息 + 新用户消息）
    const input = this.buildInput(segment.id, text)

    // 创建 UserMessage
    const now = Date.now()
    const userMessage: Message = {
      id: randomUUID(),
      conversationId,
      segmentId: segment.id,
      role: 'user',
      content: text,
      reasoningMeta: null,
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

    // 更新会话标题（第一条用户消息）
    if (conversation.title === '新对话') {
      const title = this.deriveTitle(text)
      this.conversations.rename(conversationId, title)
    }

    // 创建 pending AssistantMessage
    const assistantMessage: Message = {
      id: randomUUID(),
      conversationId,
      segmentId: segment.id,
      role: 'assistant',
      content: '',
      reasoningMeta: null,
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

    // 异步驱动流式生成
    void this.runGeneration(segment.systemPromptSnapshot, conversation.useModelInstructions, modelId, effortValue, assistantMessage.id, input, abortController)
  }

  private async runGeneration(
    systemPrompt: string,
    useModelInstructions: boolean,
    modelId: string,
    effort: string,
    assistantMessageId: string,
    input: Array<{ role: string; content: string }>,
    abortController: AbortController
  ): Promise<void> {
    try {
      // 动态生成基础 metadata（日期/时区不能持久化，否则跨天过期）
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

      const mathInstructions = [
        '',
        'When using LaTeX math:',
        '- Always wrap inline math with \\( ... \\).',
        '- Always wrap display math with \\[ ... \\].',
        '- Do not emit bare LaTeX commands outside math delimiters.',
      ].join('\n')

      const instructions = modelInstructions
        ? `${modelInstructions}\n\n${baseMetadata}${mathInstructions}`
        : `${baseMetadata}${mathInstructions}`

      const request = {
        model: modelId,
        instructions,
        input,
        store: false,
        stream: true,
        ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
      }

      console.log('[ChatGPTConversationService] Request reasoning:', JSON.stringify({ effort, summary: effort ? 'auto' : null }))

      this.messages.updateStatus(assistantMessageId, 'streaming')

      let accumulatedContent = ''
      let providerTurnId: string | null = null
      let reasoningStartedAt: number | null = null
      let totalReasoningDuration = 0

      for await (const event of this.codexClient.sendResponses(request, abortController.signal)) {
        switch (event.type) {
          case 'response.created':
            providerTurnId = this.extractResponseId(event.response)
            if (providerTurnId) {
              this.messages.updateProviderIds(assistantMessageId, providerTurnId, '')
            }
            this.emitStreamEvent({ type: 'turn-started', turnId: providerTurnId ?? '' })
            break

          case 'response.output_item.added':
            if (event.item.type === 'reasoning') {
              reasoningStartedAt = Date.now()
              this.emitStreamEvent({ type: 'reasoning-started', turnId: providerTurnId ?? '', itemId: event.item.id })
            }
            break

          case 'response.output_item.done':
            if (event.item.type === 'reasoning') {
              const phaseDuration = reasoningStartedAt ? Date.now() - reasoningStartedAt : 0
              totalReasoningDuration += phaseDuration
              const summary = (event.item.summary ?? [])
                .filter((s) => s.type === 'summary_text' && typeof s.text === 'string')
                .map((s) => s.text)
              const meta = {
                duration: totalReasoningDuration,
                effort: effort || '',
                summary,
                available: summary.length > 0,
              }
              console.log('[ChatGPTConversationService] Reasoning phase done, phaseDuration:', phaseDuration, 'totalDuration:', totalReasoningDuration, 'summary.length:', summary.length)
              if (summary.length === 0) {
                console.log('[ChatGPTConversationService] provider did not return reasoning summary')
              }
              this.messages.updateReasoningMeta(assistantMessageId, meta)
              this.emitStreamEvent({ type: 'reasoning-completed', turnId: providerTurnId ?? '', itemId: event.item.id, reasoningMeta: meta })
            }
            break

          case 'response.output_text.delta':
            accumulatedContent += event.delta
            this.messages.updateContent(assistantMessageId, accumulatedContent)
            this.emitStreamEvent({ type: 'delta', turnId: providerTurnId ?? '', text: event.delta })
            break

          case 'response.output_text.done':
            if (event.text) {
              accumulatedContent = event.text
              this.messages.updateContent(assistantMessageId, accumulatedContent)
            }
            this.emitStreamEvent({ type: 'item-completed', turnId: providerTurnId ?? '' })
            break

          case 'response.completed':
            this.messages.updateContent(assistantMessageId, accumulatedContent)
            this.messages.updateStatus(assistantMessageId, 'completed')
            this.emitStreamEvent({ type: 'turn-completed', status: 'completed' })
            break

          case 'error':
            this.messages.updateError(assistantMessageId, event.code, event.message)
            this.emitStreamEvent({ type: 'error', errorCode: event.code, errorMessage: event.message })
            break
        }
      }

      // 流结束但未收到 response.completed（被中断或异常结束）
      if (this.activeGeneration?.assistantMessageId === assistantMessageId) {
        if (abortController.signal.aborted) {
          this.messages.updateStatus(assistantMessageId, 'stopped')
          this.emitStreamEvent({ type: 'turn-completed', status: 'interrupted' })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isAborted = abortController.signal.aborted

      console.error('[ChatGPTConversationService] Stream error:', message, err instanceof Error ? err.stack : '')

      if (isAborted) {
        this.messages.updateStatus(assistantMessageId, 'stopped')
        this.emitStreamEvent({ type: 'turn-completed', status: 'interrupted' })
      } else {
        const code = 'StreamFailed'
        this.messages.updateError(assistantMessageId, code, message)
        this.emitStreamEvent({ type: 'error', errorCode: code, errorMessage: message })
      }
    } finally {
      if (this.activeGeneration?.assistantMessageId === assistantMessageId) {
        this.activeGeneration = null
      }
      await this.storage.save()
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

  private buildInput(segmentId: string, newUserText: string): Array<{ role: string; content: string }> {
    const segmentMessages = this.messages.getBySegmentId(segmentId)
    const input: Array<{ role: string; content: string }> = []

    for (const msg of segmentMessages) {
      if (msg.status === 'completed' && msg.content) {
        input.push({ role: msg.role, content: msg.content })
      }
    }

    // 新用户消息已在 sendMessage 中先入库，循环可能已包含，去重
    if (!input.some((item) => item.role === 'user' && item.content === newUserText)) {
      input.push({ role: 'user', content: newUserText })
    }

    return input
  }

  private extractResponseId(response: unknown): string {
    if (response && typeof response === 'object' && 'id' in response) {
      return String((response as { id: unknown }).id)
    }
    return ''
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
}