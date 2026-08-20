import { create } from 'zustand'

interface UiState {
  sidebarCollapsed: boolean
  settingsDialogOpen: boolean
  conversationSettingsOpen: boolean
  modelPickerOpen: boolean
  effortPickerOpen: boolean

  toggleSidebar: () => void
  setSettingsDialogOpen: (open: boolean) => void
  setConversationSettingsOpen: (open: boolean) => void
  setModelPickerOpen: (open: boolean) => void
  setEffortPickerOpen: (open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  settingsDialogOpen: false,
  conversationSettingsOpen: false,
  modelPickerOpen: false,
  effortPickerOpen: false,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  setConversationSettingsOpen: (open) => set({ conversationSettingsOpen: open }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),
}))