import { create } from 'zustand'
import type { ReasoningMeta, ReasoningDisplayMode, WebSearchResultItem } from '../../shared/types/conversation'

export type StreamStatus = 'idle' | 'starting' | 'streaming' | 'stopping'

// ReasoningDisplayMode re-exported from shared types for convenience
export type { ReasoningDisplayMode }

export interface WebSearchStatus {
  active: boolean
  callId: string | null
  toolName: string | null
  query: string | null
  error: string | null
  results: WebSearchResultItem[]
}

interface ChatStreamState {
  activeTurnId: string | null
  activeAssistantMessageId: string | null
  streamingConversationId: string | null
  // 真实 live stream 的 assistant message 身份（由 Main 创建本轮 assistant message
  // 时返回的 id 决定）。从 message 创建开始保留，直到 turn-completed / error /
  // interrupt / reset 才清空；切换会话不清空。它是 live answer 归属的唯一稳定依据，
  // 与「当前 UI 焦点」activeAssistantMessageId 是两个不同概念，不可混用。
  streamingAssistantMessageId: string | null
  status: StreamStatus
  bufferedText: string
  reasoningDisplayMode: ReasoningDisplayMode
  reasoningStatus: 'idle' | 'thinking' | 'completed'
  reasoningStartedAt: number | null
  reasoningMeta: ReasoningMeta | null
  reasoningElapsedSeconds: number
  reasoningText: string
  error: string | null
  errorCode: string | null
  errorMessage: string | null
  webSearchStatus: WebSearchStatus

  setStatus: (status: StreamStatus) => void
  setActiveTurn: (turnId: string | null) => void
  setActiveAssistantMessage: (messageId: string | null) => void
  setStreamingConversationId: (id: string | null) => void
  setStreamingAssistantMessageId: (messageId: string | null) => void
  setBufferedText: (text: string) => void
  setReasoningDisplayMode: (mode: ReasoningDisplayMode) => void
  setReasoningStatus: (status: 'idle' | 'thinking' | 'completed') => void
  setReasoningStartedAt: (timestamp: number | null) => void
  setReasoningMeta: (meta: ReasoningMeta | null) => void
  setReasoningElapsedSeconds: (seconds: number) => void
  setReasoningText: (text: string) => void
  setError: (error: string | null) => void
  setStreamError: (code: string | null, message: string | null) => void
  setWebSearchStatus: (status: Partial<WebSearchStatus>) => void
  reset: () => void
}

export const useChatStreamStore = create<ChatStreamState>((set) => ({
  activeTurnId: null,
  activeAssistantMessageId: null,
  streamingConversationId: null,
  streamingAssistantMessageId: null,
  status: 'idle',
  bufferedText: '',
  reasoningDisplayMode: 'none',
  reasoningStatus: 'idle',
  reasoningStartedAt: null,
  reasoningMeta: null,
  reasoningElapsedSeconds: 0,
  reasoningText: '',
  error: null,
  errorCode: null,
  errorMessage: null,
  webSearchStatus: { active: false, callId: null, toolName: null, query: null, error: null, results: [] },

  setStatus: (status) => set({ status }),
  setActiveTurn: (turnId) => set({ activeTurnId: turnId }),
  setActiveAssistantMessage: (messageId) => set({ activeAssistantMessageId: messageId }),
  setStreamingConversationId: (id) => set({ streamingConversationId: id }),
  setStreamingAssistantMessageId: (messageId) => set({ streamingAssistantMessageId: messageId }),
  setBufferedText: (text) => set({ bufferedText: text }),
  setReasoningDisplayMode: (mode) => set({ reasoningDisplayMode: mode }),
  setReasoningStatus: (status) => set({ reasoningStatus: status }),
  setReasoningStartedAt: (timestamp) => set({ reasoningStartedAt: timestamp }),
  setReasoningMeta: (meta) => set({ reasoningMeta: meta }),
  setReasoningElapsedSeconds: (seconds) => set({ reasoningElapsedSeconds: seconds }),
  setReasoningText: (text) => set({ reasoningText: text }),
  setError: (error) => set({ error }),
  setStreamError: (errorCode, errorMessage) => set({ errorCode, errorMessage }),
  setWebSearchStatus: (status) => set((s) => ({ webSearchStatus: { ...s.webSearchStatus, ...status } })),
  reset: () =>
    set({
      activeTurnId: null,
      activeAssistantMessageId: null,
      streamingConversationId: null,
      streamingAssistantMessageId: null,
      status: 'idle',
      bufferedText: '',
      reasoningDisplayMode: 'none',
      reasoningStatus: 'idle',
      reasoningStartedAt: null,
      reasoningMeta: null,
      reasoningElapsedSeconds: 0,
      reasoningText: '',
      error: null,
      errorCode: null,
      errorMessage: null,
      webSearchStatus: { active: false, callId: null, toolName: null, query: null, error: null, results: [] },
    }),
}))