import { randomUUID } from 'crypto'
import { ConversationRepository } from '../storage/ConversationRepository'
import { ContextSegmentRepository } from '../storage/ContextSegmentRepository'
import { MessageRepository } from '../storage/MessageRepository'
import { StorageService } from '../storage/StorageService'
import { ThreadService, buildDeveloperInstructions } from '../openai/ThreadService'
import { ChatService } from '../openai/ChatService'
import { ModelService } from '../openai/ModelService'
import type {
  Conversation,
  ContextSegment,
  Message,
  SegmentReason,
  MessageStatus,
} from '../../shared/types/conversation'
import { TITLE_MAX_LENGTH } from '../../shared/constants'

export interface StreamEvent {
  type: 'delta' | 'turn-started' | 'item-started' | 'item-completed' | 'turn-completed' | 'error'
  conversationId?: string
  turnId?: string
  itemId?: string
  text?: string
  status?: string
  errorCode?: string
  errorMessage?: string
}

export class ConversationService {
  private conversations: ConversationRepository
  private segments: ContextSegmentRepository
  private messages: MessageRepository
  private storage: StorageService
  private threadService: ThreadService
  private chatService: ChatService
  private modelService: ModelService

  // 全局只允许一个 active generation
  private activeGeneration: {
    conversationId: string
    turnId: string | null
    threadId: string | null
    assistantMessageId: string | null
  } | null = null

  private streamHandlers: Array<(event: StreamEvent) => void> = []

  constructor(
    storage: StorageService,
    threadService: ThreadService,
    chatService: ChatService,
    modelService: ModelService
  ) {
    this.storage = storage
    this.conversations = new ConversationRepository(storage)
    this.segments = new ContextSegmentRepository(storage)
    this.messages = new MessageRepository(storage)
    this.threadService = threadService
    this.chatService = chatService
    this.modelService = modelService

    this.setupStreamEvents()
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

  createConversation(
    defaultModelId: string | null,
    defaultReasoningEffort: string | null,
    systemPrompt = '',
    providerConfigId: string | null = null
  ): Conversation {
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
    // 1. 查所有 provider_thread_id
    const threadIds = this.segments.listProviderThreadIds(id)

    // 2. 尝试 thread/delete（不阻止本地删除）
    for (const threadId of threadIds) {
      try {
        await this.threadService.deleteThread(threadId)
      } catch {
        // WARN: 远端清理失败，继续本地删除
      }
    }

    // 3. 本地删除（ON DELETE CASCADE 清理 segment/messages）
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
      // 直接更新当前 Segment 的 system_prompt_snapshot
      const db = this.storage.database
      db.run(
        `UPDATE context_segments SET system_prompt_snapshot = ? WHERE id = ?`,
        [newSystemPrompt, currentSegment.id]
      )
      this.conversations.updateSystemPrompt(id, newSystemPrompt, conversation.systemPromptRevision)
    } else {
      // 创建新的 ContextSegment
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

  async sendMessage(conversationId: string, text: string): Promise<{ userMessage: Message; assistantMessage: Message } | null> {
    if (this.activeGeneration) {
      throw new Error('已有正在进行的生成')
    }

    const conversation = this.conversations.getById(conversationId)
    if (!conversation) throw new Error('会话不存在')

    let segment = this.segments.getById(conversation.currentSegmentId)
    if (!segment) throw new Error('当前上下文段不存在')

    // 确保 provider thread 存在
    let threadId: string | null = segment.providerThreadId
    if (!threadId) {
      try {
        threadId = await this.threadService.startThread(
          conversation.defaultModelId ?? '',
          buildDeveloperInstructions(segment.systemPromptSnapshot)
        )
        this.segments.setProviderThreadId(segment.id, threadId)
      } catch (err) {
        // thread 创建失败，标记为 provider context lost
        this.emitStreamEvent({
          type: 'error',
          conversationId,
          errorCode: 'ThreadStartFailed',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    }

    // 创建 UserMessage
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

    this.activeGeneration = {
      conversationId,
      turnId: null,
      threadId,
      assistantMessageId: assistantMessage.id,
    }

    // 发送 turn/start
    try {
      const turnId = await this.chatService.startTurn({
        threadId,
        input: text,
        model: conversation.defaultModelId ?? undefined,
        effort: conversation.defaultReasoningEffort ?? undefined,
      })

      this.activeGeneration.turnId = turnId
      this.messages.updateProviderIds(assistantMessage.id, turnId, '')
      this.messages.updateStatus(assistantMessage.id, 'streaming')
      return { userMessage, assistantMessage }
    } catch (err) {
      this.messages.updateError(
        assistantMessage.id,
        'TurnStartFailed',
        err instanceof Error ? err.message : String(err)
      )
      this.activeGeneration = null
      this.emitStreamEvent({
        type: 'error',
        conversationId,
        errorCode: 'TurnStartFailed',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeGeneration || !this.activeGeneration.turnId || !this.activeGeneration.threadId) {
      return
    }

    const { threadId, turnId, assistantMessageId } = this.activeGeneration

    try {
      await this.chatService.interruptTurn(threadId, turnId)
    } catch {
      // 中断失败不阻塞
    }

    if (assistantMessageId) {
      this.messages.updateStatus(assistantMessageId, 'stopped')
    }

    this.activeGeneration = null
    await this.storage.save()
  }

  private deriveTitle(text: string): string {
    const trimmed = text.trim().replace(/\n/g, ' ')
    return trimmed.slice(0, TITLE_MAX_LENGTH) || '新对话'
  }

  private setupStreamEvents(): void {
    this.chatService.onStreamEvent((method, params) => {
      this.handleStreamEvent(method, params)
    })
  }

  private handleStreamEvent(method: string, params: unknown): void {
    const event = params as Record<string, unknown>
    const conversationId = this.activeGeneration?.conversationId

    switch (method) {
      case 'turn/started': {
        const turn = event.turn as Record<string, unknown> | undefined
        this.emitStreamEvent({ type: 'turn-started', conversationId, turnId: String(turn?.id ?? '') })
        break
      }

      case 'item/started':
        this.emitStreamEvent({
          type: 'item-started',
          conversationId,
          turnId: String(event.turnId),
          itemId: String(event.itemId),
        })
        break

      case 'item/agentMessage/delta':
        this.emitStreamEvent({
          type: 'delta',
          conversationId,
          turnId: String(event.turnId),
          itemId: String(event.itemId),
          text: String(event.delta ?? ''),
        })
        break

      case 'item/completed':
        this.handleItemCompleted(event)
        this.emitStreamEvent({
          type: 'item-completed',
          conversationId,
          turnId: String(event.turnId),
          itemId: String(event.itemId),
        })
        break

      case 'turn/completed':
        this.handleTurnCompleted(event)
        break

      case 'error':
        this.handleError(event)
        break
    }
  }

  private async handleTurnCompleted(event: Record<string, unknown>): Promise<void> {
    const status = String(event.status ?? 'completed')
    const conversationId = this.activeGeneration?.conversationId

    if (this.activeGeneration && this.activeGeneration.assistantMessageId) {
      const messageStatus: MessageStatus =
        status === 'interrupted' ? 'stopped' : status === 'failed' ? 'failed' : 'completed'

      // 从 turn.items 提取 agentMessage 的完整文本
      const turn = event.turn as Record<string, unknown> | undefined
      const items = (turn?.items as Array<Record<string, unknown>>) ?? []
      const fullContent = this.extractAssistantContent(items)

      if (fullContent) {
        this.messages.updateContent(this.activeGeneration.assistantMessageId, fullContent)
      }
      this.messages.updateStatus(this.activeGeneration.assistantMessageId, messageStatus)
      this.activeGeneration = null
      await this.storage.save()
    }

    this.emitStreamEvent({ type: 'turn-completed', conversationId, status })
  }

  private handleItemCompleted(event: Record<string, unknown>): void {
    // item/completed 携带完整 item 内容，可用于增量持久化
    const item = event.item as Record<string, unknown> | undefined
    if (item?.type === 'agentMessage' && this.activeGeneration?.assistantMessageId) {
      const text = String(item.text ?? '')
      if (text) {
        this.messages.updateContent(this.activeGeneration.assistantMessageId, text)
      }
      const itemId = String(item.id ?? '')
      if (itemId) {
        this.messages.updateProviderItemId(this.activeGeneration.assistantMessageId, itemId)
      }
    }
  }

  private extractAssistantContent(items: Array<Record<string, unknown>>): string {
    for (const item of items) {
      if (item.type === 'agentMessage' && item.text) {
        return String(item.text)
      }
    }
    return ''
  }

  private handleError(event: Record<string, unknown>): void {
    const error = event.error as Record<string, unknown> | undefined
    const code = error ? String(error.code ?? 'Unknown') : 'Unknown'
    const message = error ? String(error.message ?? '') : ''
    const conversationId = this.activeGeneration?.conversationId

    if (this.activeGeneration && this.activeGeneration.assistantMessageId) {
      this.messages.updateError(this.activeGeneration.assistantMessageId, code, message)
      this.activeGeneration = null
    }

    this.emitStreamEvent({ type: 'error', conversationId, errorCode: code, errorMessage: message })
  }
}