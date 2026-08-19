import { create } from 'zustand'

interface UiState {
  sidebarCollapsed: boolean
  roleDialogOpen: boolean
  settingsDialogOpen: boolean
  modelPickerOpen: boolean
  effortPickerOpen: boolean

  toggleSidebar: () => void
  setRoleDialogOpen: (open: boolean) => void
  setSettingsDialogOpen: (open: boolean) => void
  setModelPickerOpen: (open: boolean) => void
  setEffortPickerOpen: (open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  roleDialogOpen: false,
  settingsDialogOpen: false,
  modelPickerOpen: false,
  effortPickerOpen: false,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setRoleDialogOpen: (open) => set({ roleDialogOpen: open }),
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),
}))