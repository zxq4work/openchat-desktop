import { create } from 'zustand'
import type { ModelInfo } from '../../shared/types/model'

interface ModelState {
  models: ModelInfo[]
  loading: boolean
  lastUpdatedAt: number | null
  error: string | null
  setModels: (models: ModelInfo[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useModelStore = create<ModelState>((set) => ({
  models: [],
  loading: false,
  lastUpdatedAt: null,
  error: null,
  setModels: (models) => set({ models, lastUpdatedAt: Date.now() }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}))