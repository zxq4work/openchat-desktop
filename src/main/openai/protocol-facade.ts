/**
 * Protocol Facade — 业务层与 generated schema 之间的适配层。
 * 禁止直接修改 vendor/ 下的 generated schema 文件。
 * 升级协议时只需修改此文件。
 */

import type { ReasoningEffort } from '../../../vendor/openai/codex-0.148.0/schema-ts/ReasoningEffort'
import type { ReasoningEffortOption } from '../../../vendor/openai/codex-0.148.0/schema-ts/v2/ReasoningEffortOption'
import type { InputModality } from '../../../vendor/openai/codex-0.148.0/schema-ts/InputModality'

// 业务层模型信息类型
export interface ModelInfo {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  defaultReasoningEffort: ReasoningEffort
  supportedReasoningEfforts: ReasoningEffortOption[]
  inputModalities: InputModality[]
  supportsPersonality: boolean
  isDefault: boolean
}

// 推理强度 ID
export type ReasoningEffortId = string

// 公开账号信息（Renderer 安全边界）
export interface PublicAccountInfo {
  loggedIn: boolean
  email: string | null
  planType: string | null
  accountId: string | null
}

// 认证状态
export type AuthStatus = 'unknown' | 'logged-out' | 'logging-in' | 'logged-in'

// 会话数据模型
export interface ConversationData {
  id: string
  title: string
  systemPrompt: string
  systemPromptRevision: number
  defaultModelId: string | null
  defaultReasoningEffort: string | null
  currentSegmentId: string
  createdAt: number
  updatedAt: number
}

export type SegmentReason =
  | 'conversation-created'
  | 'new-topic'
  | 'system-prompt-changed'
  | 'provider-context-lost'

export interface ContextSegmentData {
  id: string
  conversationId: string
  sequence: number
  reason: SegmentReason
  providerThreadId: string | null
  systemPromptRevision: number
  systemPromptSnapshot: string
  createdAt: number
}

export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed'

export interface MessageData {
  id: string
  conversationId: string
  segmentId: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  modelId: string | null
  reasoningEffort: string | null
  providerTurnId: string | null
  providerItemId: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

// 流式事件类型
export interface StreamEvent {
  type: 'delta' | 'turn-started' | 'item-started' | 'item-completed' | 'turn-completed' | 'error'
  turnId?: string
  itemId?: string
  text?: string
  status?: string
  errorCode?: string
  errorMessage?: string
}

// 不可以在此文件中直接引用 vendor generated types 之外的类型
// 确保业务层只通过 facade 访问协议类型