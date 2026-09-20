import { create } from 'zustand'

export interface SafeProviderConfig {
  id: string
  name: string
  protocol: 'chat_completions' | 'responses'
  baseUrl: string
  models: string[]
  modelsPath?: string
  chatCompletionsPath?: string
  responsesPath?: string
  extraHeaders?: Record<string, string>
  toolCalling: 'auto' | 'enabled' | 'disabled'
  // 该 Provider 的模型是否支持图片输入（无法从模型名推断，需显式声明）
  imageInput?: boolean
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}

interface ProviderState {
  providers: SafeProviderConfig[]
  setProviders: (providers: SafeProviderConfig[]) => void
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  setProviders: (providers) => set({ providers }),
}))