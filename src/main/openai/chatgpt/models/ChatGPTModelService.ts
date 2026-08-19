import type { ModelInfo } from '../../../../shared/types/model'
import type { ChatGPTCodexClient, ChatGPTModel } from '../transport/ChatGPTCodexClient'

export class ChatGPTModelService {
  private client: ChatGPTCodexClient
  private models: ModelInfo[] = []
  private loading = false
  private lastUpdatedAt: number | null = null
  private error: string | null = null

  constructor(client: ChatGPTCodexClient) {
    this.client = client
  }

  get currentModels(): ModelInfo[] {
    return this.models
  }

  get state() {
    return {
      models: this.models,
      loading: this.loading,
      lastUpdatedAt: this.lastUpdatedAt,
      error: this.error,
    }
  }

  async fetchModels(): Promise<ModelInfo[]> {
    this.loading = true
    this.error = null

    try {
      const rawModels = await this.client.listModels()
      this.models = rawModels.map((m) => this.toModelInfo(m))
      this.lastUpdatedAt = Date.now()
      return this.models
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.error = message
      return this.models
    } finally {
      this.loading = false
    }
  }

  resolveEffort(model: ModelInfo, previous: string | null): string | null {
    const supported = model.supportedReasoningEfforts.map((item: { reasoningEffort: string }) => item.reasoningEffort)

    if (previous && supported.includes(previous)) {
      return previous
    }

    if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
      return model.defaultReasoningEffort
    }

    return supported[0] ?? null
  }

  private toModelInfo(item: ChatGPTModel): ModelInfo {
    return {
      // /responses 端点按 slug 识别模型；id 字段在真实 API 中可能缺失
      id: item.slug,
      model: item.slug,
      displayName: item.display_name,
      hidden: false,
      defaultReasoningEffort: this.extractReasoningLevel(item.default_reasoning_level),
      supportedReasoningEfforts: (item.supported_reasoning_levels ?? [])
        .map((level: unknown) => this.extractReasoningLevel(level))
        .filter((v): v is string => v != null)
        .map((reasoningEffort) => ({
          reasoningEffort,
          description: null,
        })),
      inputModalities: item.input_modalities,
      supportsPersonality: item.supports_personality,
      isDefault: item.is_default,
    }
  }

  private extractReasoningLevel(raw: unknown): string | null {
    if (typeof raw === 'string') return raw
    if (!raw) return null
    const obj = raw as Record<string, unknown>
    // 尝试已知的键名
    const val = obj.effort ?? obj.level ?? obj.reasoning_effort ?? obj.reasoning_level ?? obj.value
    if (typeof val === 'string') return val
    console.error('[ChatGPTModelService] Unknown reasoning level shape:', JSON.stringify(raw))
    return null
  }
}