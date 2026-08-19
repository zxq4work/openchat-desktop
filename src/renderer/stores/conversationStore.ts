import { create } from 'zustand'
import type {
  Conversation,
  ConversationSummary,
  ContextSegment,
  Message,
} from '../../shared/types/conversation'

interface ConversationState {
  summaries: ConversationSummary[]
  activeConversationId: string | null
  activeConversation: Conversation | null
  activeMessages: Message[]
  activeSegments: ContextSegment[]

  setSummaries: (summaries: ConversationSummary[]) => void
  setActiveConversationId: (id: string | null) => void
  setActiveConversation: (conversation: Conversation | null) => void
  setActiveMessages: (messages: Message[]) => void
  setActiveSegments: (segments: ContextSegment[]) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  summaries: [],
  activeConversationId: null,
  activeConversation: null,
  activeMessages: [],
  activeSegments: [],

  setSummaries: (summaries) => set({ summaries }),
  setActiveConversationId: (id) => set({ activeConversationId: id }),
  setActiveConversation: (conversation) => set({ activeConversation: conversation }),
  setActiveMessages: (messages) => set({ activeMessages: messages }),
  setActiveSegments: (segments) => set({ activeSegments: segments }),
}))