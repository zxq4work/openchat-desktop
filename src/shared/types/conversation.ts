export interface Conversation {
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

export interface Message {
  id: string
  conversationId: string
  segmentId: string
  role: 'user' | 'assistant'
  content: string
  reasoningContent: string | null
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