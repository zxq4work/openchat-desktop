import { create } from 'zustand'
import type { ReasoningMeta } from '../../shared/types/conversation'

export type StreamStatus = 'idle' | 'starting' | 'streaming' | 'stopping'

interface ChatStreamState {
  activeTurnId: string | null
  activeAssistantMessageId: string | null
  streamingConversationId: string | null
  status: StreamStatus
  bufferedText: string
  reasoningStatus: 'idle' | 'thinking' | 'completed'
  reasoningStartedAt: number | null
  reasoningMeta: ReasoningMeta | null
  reasoningElapsedSeconds: number
  error: string | null

  setStatus: (status: StreamStatus) => void
  setActiveTurn: (turnId: string | null) => void
  setActiveAssistantMessage: (messageId: string | null) => void
  setStreamingConversationId: (id: string | null) => void
  setBufferedText: (text: string) => void
  setReasoningStatus: (status: 'idle' | 'thinking' | 'completed') => void
  setReasoningStartedAt: (timestamp: number | null) => void
  setReasoningMeta: (meta: ReasoningMeta | null) => void
  setReasoningElapsedSeconds: (seconds: number) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useChatStreamStore = create<ChatStreamState>((set) => ({
  activeTurnId: null,
  activeAssistantMessageId: null,
  streamingConversationId: null,
  status: 'idle',
  bufferedText: '',
  reasoningStatus: 'idle',
  reasoningStartedAt: null,
  reasoningMeta: null,
  reasoningElapsedSeconds: 0,
  error: null,

  setStatus: (status) => set({ status }),
  setActiveTurn: (turnId) => set({ activeTurnId: turnId }),
  setActiveAssistantMessage: (messageId) => set({ activeAssistantMessageId: messageId }),
  setStreamingConversationId: (id) => set({ streamingConversationId: id }),
  setBufferedText: (text) => set({ bufferedText: text }),
  setReasoningStatus: (status) => set({ reasoningStatus: status }),
  setReasoningStartedAt: (timestamp) => set({ reasoningStartedAt: timestamp }),
  setReasoningMeta: (meta) => set({ reasoningMeta: meta }),
  setReasoningElapsedSeconds: (seconds) => set({ reasoningElapsedSeconds: seconds }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      activeTurnId: null,
      activeAssistantMessageId: null,
      streamingConversationId: null,
      status: 'idle',
      bufferedText: '',
      reasoningStatus: 'idle',
      reasoningStartedAt: null,
      reasoningMeta: null,
      reasoningElapsedSeconds: 0,
      error: null,
    }),
}))