import { create } from 'zustand'

export type StreamStatus = 'idle' | 'starting' | 'streaming' | 'stopping'

interface ChatStreamState {
  activeTurnId: string | null
  activeAssistantMessageId: string | null
  status: StreamStatus
  bufferedText: string
  bufferedReasoningText: string
  error: string | null

  setStatus: (status: StreamStatus) => void
  setActiveTurn: (turnId: string | null) => void
  setActiveAssistantMessage: (messageId: string | null) => void
  setBufferedText: (text: string) => void
  setBufferedReasoningText: (text: string) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useChatStreamStore = create<ChatStreamState>((set) => ({
  activeTurnId: null,
  activeAssistantMessageId: null,
  status: 'idle',
  bufferedText: '',
  bufferedReasoningText: '',
  error: null,

  setStatus: (status) => set({ status }),
  setActiveTurn: (turnId) => set({ activeTurnId: turnId }),
  setActiveAssistantMessage: (messageId) => set({ activeAssistantMessageId: messageId }),
  setBufferedText: (text) => set({ bufferedText: text }),
  setBufferedReasoningText: (text) => set({ bufferedReasoningText: text }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      activeTurnId: null,
      activeAssistantMessageId: null,
      status: 'idle',
      bufferedText: '',
      bufferedReasoningText: '',
      error: null,
    }),
}))