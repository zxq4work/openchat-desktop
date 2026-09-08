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