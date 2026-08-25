import { ProviderConfigRepository } from '../storage/ProviderConfigRepository'
import type { CustomProviderConfig, ModelAdapter } from '../../shared/types/provider'
import { ChatCompletionsAdapter } from './ChatCompletionsAdapter'
import { ResponsesAdapter } from './ResponsesAdapter'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { ChatGPTCodexAdapter } from './ChatGPTCodexAdapter'

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

    if (config.protocol === 'chat_completions') {
      return new ChatCompletionsAdapter({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        toolCalling,
        chatCompletionsPath: config.chatCompletionsPath,
        extraHeaders: config.extraHeaders,
        supportsReasoning: true,
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