import { ProviderConfigRepository } from '../storage/ProviderConfigRepository'
import type { CustomProviderConfig, ModelAdapter, ImageGenerationAdapter, ImageGenerationParameterProfile, ImageGenerationRequestMapping } from '../../shared/types/provider'
import { ChatCompletionsAdapter } from './ChatCompletionsAdapter'
import { ResponsesAdapter } from './ResponsesAdapter'
import { OpenAIImageGenerationAdapter } from './OpenAIImageGenerationAdapter'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { ChatGPTCodexAdapter } from './ChatGPTCodexAdapter'
import { customMinimalProfile } from '../../shared/image-generation/parameterProfile'

export type SafeProviderConfig = Omit<CustomProviderConfig, 'apiKey'> & { hasApiKey: boolean }

export class ProviderConfigService {
  private repository: ProviderConfigRepository
  private codexClient: ChatGPTCodexClient

  constructor(repository: ProviderConfigRepository, codexClient: ChatGPTCodexClient) {
    this.repository = repository
    this.codexClient = codexClient
  }

  listSafe(): SafeProviderConfig[] {
    return this.repository.listSafe()
  }

  getApiKey(id: string): string | null {
    return this.repository.getById(id)?.apiKey ?? null
  }

  getBaseUrl(id: string): string | null {
    return this.repository.getById(id)?.baseUrl ?? null
  }

  // 该 Provider 是否走 Image Generations 协议
  isImageGenerationProvider(id: string): boolean {
    return this.repository.getById(id)?.protocol === 'image_generations'
  }

  // 解析图片生成 Adapter。仅 image_generations Provider 可用，其余返回 null。
  // Adapter 只做 canonical → JSON 映射，不做 Provider 能力判断（由 Profile + Service 决定）。
  getImageAdapter(providerConfigId: string | null): ImageGenerationAdapter | null {
    if (!providerConfigId) return null
    const config = this.repository.getById(providerConfigId)
    if (!config || config.protocol !== 'image_generations') return null
    return new OpenAIImageGenerationAdapter({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      imageGenerationsPath: config.imageGenerationsPath,
      extraHeaders: config.extraHeaders,
      // wire 配置由 Profile 派生：协议字段映射（参考图位置 / response_format）。Adapter 不做 Provider 名称特判。
      wireConfig: this.deriveWireConfig(config.imageGenerationProfile),
    })
  }

  // 从 Provider Profile 派生 Adapter 构造请求体所需的协议字段映射。
  deriveWireConfig(profile: ImageGenerationParameterProfile | undefined): { requestMapping?: ImageGenerationRequestMapping } {
    if (!profile) return {}
    return { requestMapping: profile.requestMapping }
  }

  // 该 Image Generations Provider 的参数能力 Profile。
  // 非图片 Provider 或未配置 → 返回最小集（只发送 model/prompt/n），避免误判兼容性。
  getImageGenerationProfile(providerConfigId: string | null): ImageGenerationParameterProfile {
    if (!providerConfigId) return customMinimalProfile()
    const config = this.repository.getById(providerConfigId)
    if (!config || config.protocol !== 'image_generations') return customMinimalProfile()
    return config.imageGenerationProfile ?? customMinimalProfile()
  }

  create(config: Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>): SafeProviderConfig {
    const created = this.repository.create(config)
    return this.toSafe(created)
  }

  delete(id: string): void {
    this.repository.delete(id)
  }

  update(id: string, updates: Partial<Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>>): void {
    this.repository.update(id, updates)
  }

  // 根据 providerConfigId 或默认，解析 ModelAdapter
  getAdapter(providerConfigId: string | null): ModelAdapter {
    if (providerConfigId) {
      const config = this.repository.getById(providerConfigId)
      if (config) {
        return this.createAdapterFromConfig(config)
      }
    }
    // 默认 ChatGPT Codex
    return new ChatGPTCodexAdapter(this.codexClient)
  }

  private createAdapterFromConfig(config: CustomProviderConfig): ModelAdapter {
    const toolCalling = config.toolCalling !== 'disabled'

    if (config.protocol === 'image_generations') {
      throw new Error('image_generations_provider_not_chat_adapter')
    }

    if (config.protocol === 'chat_completions') {
      return new ChatCompletionsAdapter({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        toolCalling,
        chatCompletionsPath: config.chatCompletionsPath,
        extraHeaders: config.extraHeaders,
        supportsReasoning: true,
        imageInput: config.imageInput ?? false,
      })
    }
    // responses
    return new ResponsesAdapter({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      toolCalling,
      responsesPath: config.responsesPath,
      extraHeaders: config.extraHeaders,
      supportsReasoning: true,
      imageInput: config.imageInput ?? false,
    })
  }

  private toSafe(config: CustomProviderConfig): SafeProviderConfig {
    const { apiKey, ...rest } = config
    return {
      ...rest,
      hasApiKey: !!apiKey,
    }
  }
}