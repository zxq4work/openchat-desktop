import { create } from 'zustand'

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
  modelPickerOpen: boolean
  effortPickerOpen: boolean
  searchVisible: boolean
  searchQuery: string
  searchMatches: SearchMatch[]
  currentMatchIndex: number

  toggleSidebar: () => void
  setSettingsDialogOpen: (open: boolean) => void
  setConversationSettingsOpen: (open: boolean) => void
  setModelPickerOpen: (open: boolean) => void
  setEffortPickerOpen: (open: boolean) => void
  openSearch: () => void
  closeSearch: () => void
  setSearchQuery: (query: string) => void
  setSearchMatches: (matches: SearchMatch[]) => void
  setCurrentMatchIndex: (index: number) => void
  goToNextMatch: () => void
  goToPrevMatch: () => void
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  settingsDialogOpen: false,
  conversationSettingsOpen: false,
  modelPickerOpen: false,
  effortPickerOpen: false,
  searchVisible: false,
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  setConversationSettingsOpen: (open) => set({ conversationSettingsOpen: open }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),

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
}))