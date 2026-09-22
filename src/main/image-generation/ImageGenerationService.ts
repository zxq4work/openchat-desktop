import { randomUUID } from 'crypto'
import { ConversationRepository } from '../storage/ConversationRepository'
import { ContextSegmentRepository } from '../storage/ContextSegmentRepository'
import { MessageRepository } from '../storage/MessageRepository'
import { ImageGenerationRepository } from '../storage/ImageGenerationRepository'
import { StorageService } from '../storage/StorageService'
import type { ImageGenerationOperation, Message, MessageAttachment } from '../../shared/types/conversation'
import type { ImageGenerationAdapter, ImageGenerationInputImage, ImageGenerationRequest } from '../../shared/types/provider'
import { TITLE_MAX_LENGTH } from '../../shared/constants'
import { ProviderConfigService } from '../providers/ProviderConfigService'
import { AttachmentService } from '../services/attachments/AttachmentService'
import { ImageGenerationError, type ImageGenerationErrorCode } from '../providers/imageGenerationErrors'
import { validateRequestedParams, reconcileImageDefaults, validateInputImageCount } from '../../shared/image-generation/parameterProfile'
import { resolveConversationBinding, bindingBlockedMessage } from '../../shared/conversation/capabilities'

export interface ImageGenerationParams {
  size?: string | null
  quality?: string | null
  background?: string | null
  outputFormat?: string | null
}

export interface ImageGenerationStreamEvent {
  type: 'image-generation-started' | 'image-generation-completed' | 'image-generation-failed'
  conversationId: string
  generationId: string
  assistantMessageId: string
  // 仅 started：本次请求的 canonical 尺寸（可能为 null = 使用供应商默认）。
  // 供渲染进程按目标比例预留占位骨架高度，避免落图时高度突变。
  size?: string | null
  errorCode?: ImageGenerationErrorCode
  errorMessage?: string
}

// 图片生成服务。独立于 ChatGPTConversationService：
// 不构建 chat history、不 replay、无 ContextSegment 语义、无 system prompt / tools / reasoning。
// 每次 generate 都是对 POST /v1/images/generations 的独立请求。
export class ImageGenerationService {
  private conversations: ConversationRepository
  private segments: ContextSegmentRepository
  private messages: MessageRepository
  private generations: ImageGenerationRepository
  private storage: StorageService
  private providerConfigService: ProviderConfigService
  private attachmentService: AttachmentService | null = null

  // 全局只允许一个进行中的生成
  private activeGeneration: {
    conversationId: string
    assistantMessageId: string
    generationId: string
    abortController: AbortController
  } | null = null

  private streamHandlers: Array<(event: ImageGenerationStreamEvent) => void> = []

  constructor(
    storage: StorageService,
    providerConfigService: ProviderConfigService
  ) {
    this.storage = storage
    this.conversations = new ConversationRepository(storage)
    this.segments = new ContextSegmentRepository(storage)
    this.messages = new MessageRepository(storage)
    this.generations = new ImageGenerationRepository(storage)
    this.providerConfigService = providerConfigService
  }

  setAttachmentService(service: AttachmentService): void {
    this.attachmentService = service
  }

  onStreamEvent(handler: (event: ImageGenerationStreamEvent) => void): () => void {
    this.streamHandlers.push(handler)
    // 返回 disposer：Retry / service 重建前先解绑旧实例，避免同一 handler 重复订阅。
    return () => {
      const idx = this.streamHandlers.indexOf(handler)
      if (idx >= 0) this.streamHandlers.splice(idx, 1)
    }
  }

  private emit(event: ImageGenerationStreamEvent): void {
    for (const handler of this.streamHandlers) handler(event)
  }

  async generate(
    conversationId: string,
    prompt: string,
    params: ImageGenerationParams,
    inputAttachmentIds: string[] = []
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    if (this.activeGeneration) {
      throw new Error('已有正在进行的图片生成')
    }

    const conversation = this.conversations.getById(conversationId)
    if (!conversation) throw new Error('会话不存在')
    if (conversation.type !== 'image_generation') {
      throw new Error('当前会话不是图片生成会话')
    }

    const providerConfigId = conversation.providerConfigId
    // Binding 兼容性门禁：会话类型（conversation.type = image_generation）权威，
    // Provider 协议只是兼容性约束。Provider 被改成聊天协议 / 被删除只代表「原绑定失效」，
    // 按实际 binding 状态给出提示，不改变会话类型。
    const binding = resolveConversationBinding({
      conversationType: conversation.type,
      providerConfigId,
      modelId: conversation.defaultModelId,
      providers: this.providerConfigService.listSafe(),
    })
    if (binding.status === 'provider_incompatible' || binding.status === 'provider_missing' || binding.status === 'model_missing') {
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', bindingBlockedMessage(binding.status, conversation.type))
    }
    const adapter = this.providerConfigService.getImageAdapter(providerConfigId)
    if (!adapter) {
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', '当前会话未配置 Image Generations 服务')
    }

    const modelId = conversation.defaultModelId
    if (!modelId) throw new Error('未选择图片模型')

    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) throw new Error('请输入图片描述')

    const segment = this.segments.getById(conversation.currentSegmentId)
    if (!segment) throw new Error('当前上下文段不存在')

    // Profile 驱动的参数解析（Service 是权威层，不信任 UI 传入值）。
    // 必须在创建任何消息之前完成，参数非法时不应留下半成品消息。
    const profile = this.providerConfigService.getImageGenerationProfile(providerConfigId)

    // 参考图解析：只接受已在 DB 中、属于本会话且用途为 generation_input 的草稿附件。
    // 不接受 renderer 传入的任意路径 / 任意 attachmentId（防止跨会话引用与路径穿越）。
    const inputAttachments = this.resolveInputAttachments(conversationId, inputAttachmentIds)

    // 操作类型由参考图数量决定（有图 = 图生图），不依赖 UI 声明。
    const operation: ImageGenerationOperation = inputAttachments.length > 0 ? 'image_to_image' : 'text_to_image'

    // 操作能力校验：文生图 / 图生图分别按 Profile 权威判定，绝不静默退化或按供应商名称猜测。
    if (operation === 'text_to_image' && !profile.operations?.textToImage) {
      throw new ImageGenerationError('IMAGE_GENERATION_TEXT_TO_IMAGE_UNSUPPORTED', '当前图片供应商不支持文生图。')
    }
    if (operation === 'image_to_image') {
      if (!profile.operations?.imageToImage.enabled) {
        throw new ImageGenerationError('IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED', '当前图片供应商不支持参考图生成。')
      }
      // 参考图字段映射必须由用户显式配置：开启图生图但缺 requestMapping.inputImages = 配置错误。
      // 权威层防御性拒绝，不允许 UI 绕过（绝不自动猜测 extra_body.image 之类的位置）。
      if (!profile.requestMapping?.inputImages) {
        throw new ImageGenerationError(
          'IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED',
          '当前图片供应商未配置参考图请求字段。'
        )
      }
      // 数量校验（multiple=false / maxImages）由 Service 权威层完成，不能只靠 UI 限制。
      const countError = validateInputImageCount(profile, inputAttachments.length)
      if (countError) {
        throw new ImageGenerationError('IMAGE_GENERATION_TOO_MANY_INPUT_IMAGES', countError)
      }
    }

    // 会话默认值可能与当前 Profile 不匹配（Provider / Profile 变更后的遗留值）→ 先 reconciliation，
    // 把不支持 / 非法的旧值清空并回写，避免 DB 长期保存无效参数。
    const reconciled = reconcileImageDefaults(profile, {
      size: conversation.defaultImageSize,
      quality: conversation.defaultImageQuality,
      background: conversation.defaultImageBackground,
    })
    if (
      reconciled.size !== conversation.defaultImageSize ||
      reconciled.quality !== conversation.defaultImageQuality ||
      reconciled.background !== conversation.defaultImageBackground
    ) {
      this.conversations.updateImageDefaults(conversationId, reconciled.size, reconciled.quality, reconciled.background)
    }

    // 本次请求参数：UI 显式传入优先，否则用（已 reconciliation 的）会话默认。
    const requested = {
      size: params.size ?? reconciled.size,
      quality: params.quality ?? reconciled.quality,
      background: params.background ?? reconciled.background,
      outputFormat: params.outputFormat ?? null,
    }

    const { cleaned, error: paramError } = validateRequestedParams(profile, requested)
    if (paramError) {
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PARAMETER', paramError)
    }

    // metadata 保存的是"实际发送的 canonical 值"。"默认/自动" = 未发送 = null，
    // 绝不把未发送的字段写成 'auto'，否则历史记录会错误表示真实请求。
    const size = cleaned.size ?? null
    const quality = cleaned.quality ?? null
    const background = cleaned.background ?? null
    const outputFormat = cleaned.outputFormat ?? null

    // Canonical 参考图：只记录 attachmentId + metadata，字节在请求阶段才读取。
    const inputImages: ImageGenerationInputImage[] = inputAttachments.map((a) => ({
      attachmentId: a.id,
      mimeType: a.mimeType,
      fileName: a.fileName,
    }))

    const now = Date.now()
    const userMessage: Message = {
      id: randomUUID(),
      conversationId,
      segmentId: segment.id,
      role: 'user',
      content: trimmedPrompt,
      attachments: [],
      reasoningMeta: null,
      reasoningText: null,
      reasoningDisplayMode: 'none',
      webSearchResults: null,
      webSearchError: null,
      status: 'completed',
      modelId,
      reasoningEffort: null,
      providerTurnId: null,
      providerItemId: null,
      providerPayloadJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }
    this.messages.create(userMessage)

    // 参考图归属到用户消息：历史重开时可见用户当时使用的参考图。
    // message_attachments 是归属的事实源，generation metadata 只记录数量。
    if (inputAttachments.length > 0 && this.attachmentService) {
      this.attachmentService.bindDrafts(inputAttachments.map((a) => a.id), userMessage.id, conversationId, segment.id)
      userMessage.attachments = inputAttachments
    }

    if (conversation.title === '新对话') {
      this.conversations.rename(conversationId, this.deriveTitle(trimmedPrompt))
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
      reasoningDisplayMode: 'none',
      webSearchResults: null,
      webSearchError: null,
      status: 'pending',
      modelId,
      reasoningEffort: null,
      providerTurnId: null,
      providerItemId: null,
      providerPayloadJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now + 1,
      updatedAt: now + 1,
    }
    this.messages.create(assistantMessage)

    const generationId = randomUUID()
    this.generations.create({
      id: generationId,
      conversationId,
      promptMessageId: userMessage.id,
      resultMessageId: null,
      providerConfigId,
      modelId,
      prompt: trimmedPrompt,
      size,
      quality,
      background,
      outputFormat,
      n: 1,
      operation,
      inputImageCount: inputAttachments.length,
      revisedPrompt: null,
      status: 'pending',
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      completedAt: null,
    })

    const abortController = new AbortController()
    this.activeGeneration = {
      conversationId,
      assistantMessageId: assistantMessage.id,
      generationId,
      abortController,
    }

    this.emit({
      type: 'image-generation-started',
      conversationId,
      generationId,
      assistantMessageId: assistantMessage.id,
      size,
    })

    // 延迟到下一个宏任务，确保 IPC 响应先于完成/失败事件到达渲染进程
    setImmediate(() => {
      void this.runGeneration(
        conversationId,
        assistantMessage.id,
        generationId,
        adapter,
        {
          prompt: trimmedPrompt,
          model: modelId,
          size: size ?? undefined,
          quality: quality ?? undefined,
          background: background ?? undefined,
          outputFormat: outputFormat ?? undefined,
          n: 1,
          inputImages,
        },
        abortController
      )
    })

    return { userMessage, assistantMessage }
  }

  // 把 renderer 传入的 attachmentId 解析为可用的参考图草稿。
  // 只接受：存在、属于本会话、未绑定 message、usage=generation_input 的草稿。
  // 任一不满足即抛错——绝不静默忽略非法 ID（否则会悄悄变成文生图）。
  private resolveInputAttachments(conversationId: string, ids: string[]): MessageAttachment[] {
    if (ids.length === 0) return []
    if (!this.attachmentService) {
      throw new ImageGenerationError('IMAGE_GENERATION_INPUT_IMAGE_READ_FAILED', '参考图服务不可用')
    }
    const result: MessageAttachment[] = []
    for (const id of ids) {
      const att = this.attachmentService.getAttachment(id)
      if (!att || att.conversationId !== conversationId || att.messageId !== null) {
        throw new ImageGenerationError('IMAGE_GENERATION_INPUT_IMAGE_NOT_FOUND', '参考图不存在或已被删除')
      }
      if (att.usage !== 'generation_input') {
        throw new ImageGenerationError('IMAGE_GENERATION_INPUT_IMAGE_INVALID', '该附件不是图片生成参考图')
      }
      result.push(att)
    }
    return result
  }

  private async runGeneration(
    conversationId: string,
    assistantMessageId: string,
    generationId: string,
    adapter: ImageGenerationAdapter,
    request: { prompt: string; model: string; size?: string; quality?: string; background?: string; outputFormat?: string; n?: number; inputImages?: ImageGenerationInputImage[] },
    abortController: AbortController
  ): Promise<void> {
    this.messages.updateStatus(assistantMessageId, 'streaming')
    try {
      // 注入参考图字节解析器与 wire 配置：Canonical 请求只带 attachmentId，
      // 真正字节在 Adapter 构建 HTTP body 时才读取（请求结束后即释放）。
      const fullRequest: ImageGenerationRequest = {
        ...request,
        inputImageResolver: this.inputImageResolver(),
      }
      const result = await adapter.generate(fullRequest, abortController.signal)

      const attachments = []
      let revisedPrompt: string | null = null
      for (const image of result.images) {
        if (image.revisedPrompt && !revisedPrompt) revisedPrompt = image.revisedPrompt
        const att = this.persistGeneratedImage(Buffer.from(image.bytes), image.mimeType, conversationId)
        attachments.push(att)
      }

      if (attachments.length === 0) {
        throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', '图片服务未返回任何图片')
      }

      // 绑定附件归属到 assistant message（草稿 → 正式归属，message_attachments 是唯一事实源）
      if (this.attachmentService) {
        this.attachmentService.bindDrafts(
          attachments.map((a) => a.id),
          assistantMessageId,
          conversationId,
          this.messages.getById(assistantMessageId)?.segmentId ?? ''
        )
      }

      this.generations.complete(generationId, assistantMessageId, revisedPrompt)
      this.messages.updateStatus(assistantMessageId, 'completed')

      await this.storage.save()

      this.emit({
        type: 'image-generation-completed',
        conversationId,
        generationId,
        assistantMessageId,
      })
    } catch (err) {
      const code = (err as { code?: ImageGenerationErrorCode }).code
      const aborted = code === 'IMAGE_GENERATION_ABORTED'
      const errorCode: ImageGenerationErrorCode = aborted
        ? 'IMAGE_GENERATION_ABORTED'
        : code ?? 'IMAGE_GENERATION_FAILED'
      // 展示具体原因，便于用户调整参数：
      // - 本地参数校验错误：message 已是面向用户的中文（含具体参数名）
      // - Provider HTTP 错误：message 已是单行、限长的安全摘要
      // - 其它：按 code 回退为通用文案，绝不 dump 原始 body。
      const ownMessage = typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : ''
      const errorMessage = aborted
        ? '已停止生成'
        : (ownMessage && err instanceof ImageGenerationError)
          ? ownMessage
          : this.userFacingMessage(errorCode)

      this.messages.updateError(assistantMessageId, errorCode, errorMessage)
      this.generations.setStatus(generationId, aborted ? 'stopped' : 'failed', errorCode, errorMessage)
      await this.storage.save()

      this.emit({
        type: 'image-generation-failed',
        conversationId,
        generationId,
        assistantMessageId,
        errorCode,
        errorMessage,
      })
    } finally {
      if (this.activeGeneration?.generationId === generationId) {
        this.activeGeneration = null
      }
    }
  }

  // 参考图字节解析器（主进程注入）：attachmentId → 受管文件的真实字节 + MIME。
  // 只按 DB 反查受管路径，绝不使用 renderer 提供的任意路径。
  private inputImageResolver() {
    const service = this.attachmentService
    if (!service) return undefined
    return {
      resolveForGeneration: (attachmentId: string) => service.resolveForGeneration(attachmentId),
    }
  }

  private persistGeneratedImage(bytes: Buffer, mimeType: string, conversationId: string) {
    if (!this.attachmentService) throw new Error('attachment_service_unavailable')
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
    const fileName = `generated_${Date.now()}.${ext}`
    return this.attachmentService.prepareGeneratedImage(bytes, fileName, conversationId)
  }

  private userFacingMessage(code: ImageGenerationErrorCode): string {
    switch (code) {
      case 'IMAGE_GENERATION_UNSUPPORTED':
        return '当前模型不支持所选参数。'
      case 'IMAGE_GENERATION_INVALID_PARAMETER':
        return '当前图片供应商不支持所选生成参数。请检查尺寸、质量或背景设置。'
      case 'IMAGE_GENERATION_TEXT_TO_IMAGE_UNSUPPORTED':
        return '当前图片供应商不支持文生图。'
      case 'IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED':
        return '当前图片供应商不支持参考图生成。'
      case 'IMAGE_GENERATION_TOO_MANY_INPUT_IMAGES':
        return '参考图数量超出当前供应商允许的上限。'
      case 'IMAGE_GENERATION_INPUT_IMAGE_NOT_FOUND':
        return '参考图不存在或已被删除。'
      case 'IMAGE_GENERATION_INPUT_IMAGE_INVALID':
        return '参考图无效。'
      case 'IMAGE_GENERATION_INPUT_IMAGE_READ_FAILED':
        return '参考图读取失败。'
      case 'IMAGE_GENERATION_INVALID_RESPONSE':
        return '图片服务返回的数据无效。'
      case 'IMAGE_GENERATION_DOWNLOAD_FAILED':
        return '图片下载失败。'
      case 'IMAGE_GENERATION_DECODE_FAILED':
        return '返回的图片无法解码。'
      default:
        return '图片生成失败。'
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeGeneration) return
    this.activeGeneration.abortController.abort()
  }

  isGenerating(): boolean {
    return !!this.activeGeneration
  }

  listGenerations(conversationId: string) {
    return this.generations.getByConversationId(conversationId)
  }

  private deriveTitle(text: string): string {
    const trimmed = text.trim().replace(/\n/g, ' ')
    return trimmed.slice(0, TITLE_MAX_LENGTH) || '新对话'
  }
}

