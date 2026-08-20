import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'openchat.themeMode'

function getSystemTheme(): ResolvedTheme {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return getSystemTheme()
  return mode
}

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  cycle: () => void
  applySystemTheme: () => void
}

const CYCLE_ORDER: ThemeMode[] = ['light', 'dark', 'system']

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStoredMode(),
  resolved: resolveTheme(readStoredMode()),

  setMode: (mode) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, mode)
    }
    set({ mode, resolved: resolveTheme(mode) })
  },

  cycle: () => {
    const { mode } = get()
    const next = CYCLE_ORDER[(CYCLE_ORDER.indexOf(mode) + 1) % CYCLE_ORDER.length]
    get().setMode(next)
  },

  applySystemTheme: () => {
    const { mode } = get()
    set({ resolved: resolveTheme(mode) })
  },
}))
