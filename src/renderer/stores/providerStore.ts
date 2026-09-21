import { create } from 'zustand'
import type { ImageGenerationParameterProfile } from '../../shared/types/provider'

export interface SafeProviderConfig {
  id: string
  name: string
  protocol: 'chat_completions' | 'responses' | 'image_generations'
  baseUrl: string
  models: string[]
  modelsPath?: string
  chatCompletionsPath?: string
  responsesPath?: string
  imageGenerationsPath?: string
  // Image Generation 参数能力 Profile（仅 image_generations 协议有意义）
  imageGenerationProfile?: ImageGenerationParameterProfile
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