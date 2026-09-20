export interface Conversation {
  id: string
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
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
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
  createdAt: number
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