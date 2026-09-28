import { ProviderConfigRepository } from '../storage/ProviderConfigRepository'
import type { CustomProviderConfig, ModelAdapter, ImageGenerationAdapter, ImageGenerationParameterProfile, ImageGenerationRequestMapping, RequestParameterProfile, DynamicRequestParameterDefinition } from '../../shared/types/provider'
import { ChatCompletionsAdapter } from './ChatCompletionsAdapter'
import { ResponsesAdapter } from './ResponsesAdapter'
import { OpenAIImageGenerationAdapter } from './OpenAIImageGenerationAdapter'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { ChatGPTCodexAdapter } from './ChatGPTCodexAdapter'
import { customMinimalProfile } from '../../shared/image-generation/parameterProfile'
import {
  validateRequestParameterProfile,
  resolveRequestParameters,
  computeReservedRequestPaths,
  findDynamicParameterConflict,
} from '../../shared/request-parameters/requestParameters'

// 保留 path / 冲突检测的单一实现位于 shared/request-parameters，供 Main 与 Renderer 共用。
// 此处 re-export 保持既有调用点（ImageGenerationService / ChatGPTConversationService）不变。
export { computeReservedRequestPaths, findDynamicParameterConflict }

export type SafeProviderConfig = Omit<CustomProviderConfig, 'apiKey'> & { hasApiKey: boolean }

// 动态参数 Profile 校验失败：Provider 保存应被拒绝（Main 是 trust boundary）。
export class RequestParameterProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestParameterProfileError'
  }
}

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
    // 权威校验：Provider 保存时再次校验动态参数 Profile，不能只靠 Renderer。
    if (config.requestParameterProfile) {
      const reserved = computeReservedRequestPaths(config.protocol, config.imageGenerationProfile)
      const err = validateRequestParameterProfile(config.requestParameterProfile, config.protocol, reserved)
      if (err) throw new RequestParameterProfileError(err)
    }
    const created = this.repository.create(config)
    return this.toSafe(created)
  }

  delete(id: string): void {
    this.repository.delete(id)
  }

  update(id: string, updates: Partial<Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>>): void {
    // 只要 requestParameterProfile 或 imageGenerationProfile（决定保留 path）发生变化，
    // 就用「本次更新优先 + DB 旧值兜底」的有效配置重新校验，避免改映射后产生冲突。
    const profileChanging =
      updates.requestParameterProfile !== undefined || updates.imageGenerationProfile !== undefined
    if (profileChanging) {
      const existing = this.repository.getById(id)
      const protocol = updates.protocol ?? existing?.protocol
      const effectiveProfile = updates.requestParameterProfile !== undefined
        ? updates.requestParameterProfile
        : existing?.requestParameterProfile
      if (protocol && effectiveProfile) {
        const imageProfile = updates.imageGenerationProfile !== undefined
          ? updates.imageGenerationProfile
          : existing?.imageGenerationProfile
        const reserved = computeReservedRequestPaths(protocol, imageProfile)
        const err = validateRequestParameterProfile(effectiveProfile, protocol, reserved)
        if (err) throw new RequestParameterProfileError(err)
      }
    }
    this.repository.update(id, updates)
  }

  // 解析某 Provider + Model 的最终动态参数定义（Provider 级 + Model override）。
  // 未配置 → 返回 []，请求体完全不变。ChatGPT Codex 内建路径不经过此方法。
  getResolvedRequestParameters(providerConfigId: string | null, modelId: string | null): DynamicRequestParameterDefinition[] {
    if (!providerConfigId) return []
    const config = this.repository.getById(providerConfigId)
    if (!config) return []
    return resolveRequestParameters(config.requestParameterProfile, modelId)
  }

  // 该 Provider 的动态参数 Profile（供 UI 读取 schema；Send 时 Main 会再次权威 resolve）。
  getRequestParameterProfile(providerConfigId: string | null): RequestParameterProfile | undefined {
    if (!providerConfigId) return undefined
    return this.repository.getById(providerConfigId)?.requestParameterProfile
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