import { create } from 'zustand'
import type { MessageAttachment } from '../../shared/types/conversation'

export interface SearchMatch {
  messageId: string
  globalIndex: number
  start: number
  end: number
}

interface UiState {
  sidebarCollapsed: boolean
  settingsDialogOpen: boolean
  conversationSettingsOpen: boolean
  conversationSettingsTargetId: string | null
  modelPickerOpen: boolean
  effortPickerOpen: boolean
  searchVisible: boolean
  searchQuery: string
  searchMatches: SearchMatch[]
  currentMatchIndex: number
  focusRequestId: number
  toast: string | null
  // 全局图片 Lightbox：草稿与历史消息共用同一实例
  lightboxAttachment: MessageAttachment | null

  toggleSidebar: () => void
  requestComposerFocus: () => void
  showToast: (message: string) => void
  clearToast: () => void
  setSettingsDialogOpen: (open: boolean) => void
  setConversationSettingsOpen: (open: boolean) => void
  setConversationSettingsTargetId: (id: string | null) => void
  setModelPickerOpen: (open: boolean) => void
  setEffortPickerOpen: (open: boolean) => void
  openLightbox: (attachment: MessageAttachment) => void
  closeLightbox: () => void
  openSearch: () => void
  closeSearch: () => void
  setSearchQuery: (query: string) => void
  setSearchMatches: (matches: SearchMatch[]) => void
  setCurrentMatchIndex: (index: number) => void
  goToNextMatch: () => void
  goToPrevMatch: () => void
  // 初始化失败 / 超时的降级错误态：非 null 时主界面替换为错误页 + 「重试初始化」。
  initError: { timedOut: boolean; message: string } | null
  initRetrying: boolean
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  settingsDialogOpen: false,
  conversationSettingsOpen: false,
  conversationSettingsTargetId: null,
  modelPickerOpen: false,
  effortPickerOpen: false,
  searchVisible: false,
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,
  focusRequestId: 0,
  toast: null,
  lightboxAttachment: null,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  requestComposerFocus: () => set((state) => ({ focusRequestId: state.focusRequestId + 1 })),
  showToast: (message) => set({ toast: message }),
  clearToast: () => set({ toast: null }),
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  setConversationSettingsOpen: (open) => set({ conversationSettingsOpen: open }),
  setConversationSettingsTargetId: (id) => set({ conversationSettingsTargetId: id }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),
  openLightbox: (attachment) => set({ lightboxAttachment: attachment }),
  closeLightbox: () => set({ lightboxAttachment: null }),

  openSearch: () => set({ searchVisible: true, searchQuery: '', searchMatches: [], currentMatchIndex: -1 }),
  closeSearch: () => set({ searchVisible: false, searchQuery: '', searchMatches: [], currentMatchIndex: -1 }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchMatches: (matches) => set({ searchMatches: matches, currentMatchIndex: matches.length > 0 ? 0 : -1 }),
  setCurrentMatchIndex: (index) => set({ currentMatchIndex: index }),
  goToNextMatch: () => {
    const { searchMatches, currentMatchIndex } = get()
    if (searchMatches.length === 0) return
    const next = (currentMatchIndex + 1) % searchMatches.length
    set({ currentMatchIndex: next })
  },
  goToPrevMatch: () => {
    const { searchMatches, currentMatchIndex } = get()
    if (searchMatches.length === 0) return
    const prev = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length
    set({ currentMatchIndex: prev })
  },
  initError: null,
  initRetrying: false,
  setInitError: (error) => set({ initError: error, initRetrying: false }),
  setInitRetrying: (retrying) => set({ initRetrying: retrying }),
}))