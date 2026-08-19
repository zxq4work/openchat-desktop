import { OpenAIAppServerClient } from './OpenAIAppServerClient'
import type { ModelInfo } from '../../shared/types/model'
import type { Model } from '../../../vendor/openai/codex-0.148.0/schema-ts/v2/Model'

export class ModelService {
  private client: OpenAIAppServerClient
  private models: ModelInfo[] = []
  private loading = false
  private lastUpdatedAt: number | null = null
  private error: string | null = null

  constructor(client: OpenAIAppServerClient) {
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
      const result: ModelInfo[] = []
      let cursor: string | null = null

      do {
        const params: {
          limit: number
          includeHidden: boolean
          cursor?: string | null
        } = {
          limit: 20,
          includeHidden: false,
        }
        if (cursor) {
          params.cursor = cursor
        }
        const page = await this.client.listModels(params)
        result.push(...page.data.map(this.toModelInfo))
        cursor = page.nextCursor
      } while (cursor)

      this.models = result
      this.lastUpdatedAt = Date.now()
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.error = message
      return this.models
    } finally {
      this.loading = false
    }
  }

  /**
   * 推理强度修正规则：
   * 如果 B 支持 previous，继续 previous
   * 否则用 defaultReasoningEffort
   * 否则用 supportedReasoningEfforts[0]
   */
  resolveEffort(model: ModelInfo, previous: string | null): string | null {
    const supported = model.supportedReasoningEfforts.map((item) => item.reasoningEffort)

    if (previous && supported.includes(previous)) {
      return previous
    }

    if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
      return model.defaultReasoningEffort
    }

    return supported[0] ?? null
  }

  private toModelInfo(item: Model): ModelInfo {
    return {
      id: item.id,
      model: item.model,
      displayName: item.displayName,
      hidden: item.hidden,
      defaultReasoningEffort: item.defaultReasoningEffort ?? null,
      supportedReasoningEfforts: (item.supportedReasoningEfforts ?? []).map((s) => ({
        reasoningEffort: s.reasoningEffort,
        description: s.description ?? null,
      })),
      inputModalities: item.inputModalities,
      supportsPersonality: item.supportsPersonality,
      isDefault: item.isDefault,
    }
  }
}