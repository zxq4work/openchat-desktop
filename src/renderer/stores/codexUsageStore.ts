import { create } from 'zustand'
import type { CodexUsageView } from '../../shared/types/usage'

interface CodexUsageState {
  usage: CodexUsageView
  setUsage: (usage: CodexUsageView) => void
}

export const useCodexUsageStore = create<CodexUsageState>((set) => ({
  usage: { state: 'unknown' },
  setUsage: (usage) => set({ usage }),
}))

export function isCodexExhausted(usage: CodexUsageView): boolean {
  if (usage.state !== 'exhausted') return false
  if (usage.resetAt == null) return false
  return usage.resetAt * 1000 > Date.now()
}
