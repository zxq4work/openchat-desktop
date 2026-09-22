// 会话类型：chat 走文字对话协议，image_generation 只走 POST /v1/images/generations。
// 两者协议不同，一旦会话产生首条消息即锁定，不得互相切换。
export type ConversationType = 'chat' | 'image_generation'

export interface Conversation {
  id: string
  type: ConversationType
  title: string
  systemPrompt: string
  systemPromptRevision: number
  defaultModelId: string | null
  defaultReasoningEffort: string | null
  currentSegmentId: string
  useModelInstructions: boolean
  webSearchEnabled: boolean
  codexSearchMode: 'hosted' | 'standalone'
  searchEngine: 'bing' | 'baidu' | 'google'
  providerConfigId: string | null
  // Binding 名称快照：仅用于「Provider/Model 已失效」时向用户展示历史上绑定的是什么。
  // 绝不作为发送配置使用（发送永远按当前 registry + providerConfigId/modelId 解析）。
  // 旧数据可能为空 —— 打开时按当前 registry lazy 回退，写 binding 时补写。
  providerNameSnapshot: string | null
  modelNameSnapshot: string | null
  // Image Generation 会话默认图片参数（type=image_generation 时使用）
  defaultImageSize: string | null
  defaultImageQuality: string | null
  defaultImageBackground: string | null
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  type: ConversationType
  title: string
  updatedAt: number
  preview: string
}

export type SegmentReason =
  | 'conversation-created'
  | 'new-topic'
  | 'system-prompt-changed'
  | 'provider-context-lost'

export interface ContextSegment {
  id: string
  conversationId: string
  sequence: number
  reason: SegmentReason
  providerThreadId: string | null
  systemPromptRevision: number
  systemPromptSnapshot: string
  createdAt: number
}

export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'stopped'
  | 'failed'

export interface ReasoningMeta {
  duration: number
  effort: string
  summary: string[]
  available: boolean
}

export interface WebSearchResultItem {
  title: string | null
  url: string | null
  snippet: string | null
  sourceType?: 'web' | 'api'
}

export type ReasoningDisplayMode = 'none' | 'summary' | 'live'

// 图片附件支持的详细程度（与 Responses / Codex input_image.detail 对齐）
export type ImageDetail = 'auto' | 'low' | 'high'

// 附件来源：user_upload（用户上传/粘贴/拖拽）或 ai_generated（图片生成结果）。
export type AttachmentSource = 'user_upload' | 'ai_generated'

// 附件用途：明确图片在系统中的语义角色，避免用 source 表达业务含义。
// - chat_input：Chat 会话的图片输入（进入 Chat model 的 vision 上下文）
// - generation_input：图片生成会话的参考图（进入 Image Generation Provider 请求）
// - generation_output：AI 生成的图片结果
export type AttachmentUsage = 'chat_input' | 'generation_input' | 'generation_output'

// 消息附件（第一版仅支持图片）。
// 图片本体存放于 userData/attachments 目录，DB 只保存 metadata 与受管理的相对路径信息。
export interface MessageAttachment {
  id: string
  // 草稿阶段为 null，发送后绑定到具体 message
  messageId: string | null
  conversationId: string | null
  segmentId: string | null
  type: 'image'
  mimeType: string
  fileName: string
  fileSize: number
  width: number
  height: number
  detail: ImageDetail
  sha256: string
  // 图片来源。AI 生成图片必须为 ai_generated，便于后续保存/重生成/引用区分。
  source: AttachmentSource
  // 附件用途。Chat 图片输入 = chat_input；图片生成参考图 = generation_input；
  // AI 生成结果 = generation_output。用于隔离 Chat 上下文与图片生成输入。
  usage: AttachmentUsage
  createdAt: number
}

// ── Image Generation 记录 ──
// Attachment 描述文件本身；image_generations 描述"为什么、如何生成这个文件"。
// 保存生成当时的真实参数，历史会话不依赖当前设置解释。

export type ImageGenerationStatus = 'pending' | 'completed' | 'failed' | 'stopped'

// 生成操作类型：文生图 / 图生图。inputImages 为空即 text_to_image。
export type ImageGenerationOperation = 'text_to_image' | 'image_to_image'

export interface ImageGeneration {
  id: string
  conversationId: string
  promptMessageId: string | null
  resultMessageId: string | null
  providerConfigId: string | null
  modelId: string | null
  prompt: string
  size: string | null
  quality: string | null
  background: string | null
  outputFormat: string | null
  n: number
  // 本次生成的操作类型与参考图数量。输入图片与消息的事实关系由 message_attachments
  // （usage=generation_input）承载，这里只冗余计数用于展示，不重复维护 attachment ID 列表。
  operation: ImageGenerationOperation
  inputImageCount: number
  revisedPrompt: string | null
  status: ImageGenerationStatus
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  completedAt: number | null
}

// 批量导入结果：单张失败不阻断整批，同时回传每条失败原因供 UI 提示。
// errors 中的失败项不会产生任何 DB 记录或落盘文件。
export interface AttachmentImportResult {
  attachments: MessageAttachment[]
  errors: Array<{ fileName: string; code: string; message: string }>
}

export interface Message {
  id: string
  conversationId: string
  segmentId: string
  role: 'user' | 'assistant'
  content: string
  attachments: MessageAttachment[]
  reasoningMeta: ReasoningMeta | null
  reasoningText: string | null
  reasoningDisplayMode: ReasoningDisplayMode
  webSearchResults: WebSearchResultItem[] | null
  webSearchError: string | null
  status: MessageStatus
  modelId: string | null
  reasoningEffort: string | null
  providerTurnId: string | null
  providerItemId: string | null
  providerPayloadJson: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}