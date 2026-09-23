import type { ModelInfo, SupportedReasoningEffort, ServiceTierInfo } from '../../../../shared/types/model'
import type { ChatGPTCodexClient, ChatGPTModel } from '../transport/ChatGPTCodexClient'
import { CHATGPT_MODEL_CATALOG_CLIENT_VERSION } from './modelCatalogVersion'
import { compareSemver } from '../../../../shared/utils/semver'

export interface ModelPrompt {
  modelId: string
  instructionsTemplate: string
}

// 判断 /models 返回的模型是否应当对用户可见。
// 只有服务器明确表示不可用/不展示时才隐藏；缺失或未知值一律保持向后兼容可见。
export function isModelVisible(item: ChatGPTModel): boolean {
  if (item.supported_in_api === false) return false
  const visibility = item.visibility
  if (visibility === 'hide' || visibility === 'none') return false
  if (visibility === 'list') return true
  if (visibility === undefined || visibility === null || visibility === '') return true
  // 未知 visibility 字符串：不因未知值删除模型，仅记录开发告警，默认保留。
  console.warn('[Models] unknown visibility=%s for model=%s, keeping visible', String(visibility), item.slug)
  return true
}

// 从 reasoning level 的宽松形状中提取 effort / description。
function normalizeReasoningLevel(
  raw: unknown
): { effort: string; description?: string } | null {
  if (typeof raw === 'string') return { effort: raw }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const val = obj.effort ?? obj.level ?? obj.reasoning_effort ?? obj.reasoning_level ?? obj.value
  if (typeof val !== 'string' || val.length === 0) return null
  const description = typeof obj.description === 'string' ? obj.description : undefined
  return { effort: val, description }
}

export class ChatGPTModelService {
  private client: ChatGPTCodexClient
  private models: ModelInfo[] = []
  private loading = false
  private lastUpdatedAt: number | null = null
  private error: string | null = null
  private instructionsTemplateMap: Map<string, string> = new Map()

  constructor(client: ChatGPTCodexClient) {
    this.client = client
  }

  getInstructionsTemplate(modelId: string): string | null {
    return this.instructionsTemplateMap.get(modelId) ?? null
  }

  get currentModels(): ModelInfo[] {
    return this.models
  }

  // 按 model id 查回 ModelInfo（ConversationService 准备请求时用）。
  // 单一事实源：绝不建立第二套模型 metadata store。
  getModelInfo(modelId: string): ModelInfo | undefined {
    return this.models.find((m) => m.id === modelId)
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
    console.log('[Models] refresh started')
    this.loading = true
    this.error = null

    try {
      const rawModels = await this.client.listModels()
      this.models = rawModels.map((m) => {
        // 捕获 instructions_template 用于默认系统提示词（既有能力，保留）
        const template = (m.model_messages as { instructions_template?: string } | undefined)?.instructions_template
          ?? m.base_instructions
        if (template) {
          this.instructionsTemplateMap.set(m.slug, template)
        }
        return this.toModelInfo(m)
      })
      this.lastUpdatedAt = Date.now()
      const visible = this.models.filter((m) => !m.hidden).length
      console.log('[Models] visible models=%d', visible)
      for (const m of this.models) {
        console.log('[Models] model=%s responsesLite=%s reasoning=[%s]',
          m.id, String(m.useResponsesLite ?? false),
          m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(','))
      }
      return this.models
    } catch (err) {
      // 刷新失败绝不清空上一次成功的内存模型列表，UI 仍可使用已有模型。
      const message = err instanceof Error ? err.message : String(err)
      this.error = message
      console.warn('[Models] refresh failed, keeping %d cached models: %s', this.models.length, message)
      return this.models
    } finally {
      this.loading = false
    }
  }

  // 切换模型时按新模型 metadata 修正推理强度：
  // 优先保留 previous（若新模型支持）→ defaultReasoningEffort → supported[0]
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

  private toModelInfo(item: ChatGPTModel): ModelInfo {
    // 能力 metadata 完全来自服务器；未知字段一律忽略，不因未知值改变行为。
    const supportedReasoningEfforts: SupportedReasoningEffort[] = (item.supported_reasoning_levels ?? [])
      .map((level) => normalizeReasoningLevel(level))
      .filter((v): v is { effort: string; description?: string } => v != null)
      .map((v) => ({ reasoningEffort: v.effort, description: v.description ?? null }))

    const defaultLevel = normalizeReasoningLevel(item.default_reasoning_level)

    // minimal_client_version 超过当前 catalog 兼容版本：安全兜底，不作为正常可用模型。
    let catalogIncompatible = false
    if (item.minimal_client_version && compareSemver(item.minimal_client_version, CHATGPT_MODEL_CATALOG_CLIENT_VERSION) > 0) {
      catalogIncompatible = true
      console.warn(
        '[Models] Model %s requires client version %s, catalog compatibility version is %s',
        item.slug, item.minimal_client_version, CHATGPT_MODEL_CATALOG_CLIENT_VERSION
      )
    }

    const serviceTiers: ServiceTierInfo[] | undefined = Array.isArray(item.service_tiers)
      ? item.service_tiers
          .filter((t): t is { id?: string; name?: string; description?: string } => !!t && typeof t === 'object')
          .map((t) => ({ id: String(t.id ?? ''), name: t.name, description: t.description }))
          .filter((t) => t.id.length > 0)
      : undefined

    return {
      // /responses 端点按 slug 识别模型；id 字段在真实 API 中可能缺失
      id: item.slug,
      model: item.slug,
      displayName: item.display_name ?? item.slug,
      description: item.description,
      hidden: !isModelVisible(item) || catalogIncompatible,
      defaultReasoningEffort: defaultLevel?.effort ?? null,
      supportedReasoningEfforts,
      inputModalities: item.input_modalities,
      supportsPersonality: item.supports_personality,
      isDefault: item.is_default,

      minimalClientVersion: item.minimal_client_version,
      supportedInApi: item.supported_in_api,
      priority: item.priority,

      useResponsesLite: item.use_responses_lite,
      supportsReasoningEffortUpdates: item.supports_reasoning_effort_updates,
      supportsParallelToolCalls: item.supports_parallel_tool_calls,

      supportsImageDetailOriginal: item.supports_image_detail_original,

      contextWindow: item.context_window,
      maxContextWindow: item.max_context_window,
      effectiveContextWindowPercent: item.effective_context_window_percent,

      // undefined = 服务器未声明（保持现有行为）；仅 false 才代表明确不支持
      supportsSearchTool: item.supports_search_tool,
      webSearchToolType: item.web_search_tool_type ?? undefined,

      supportVerbosity: item.support_verbosity,
      defaultVerbosity: item.default_verbosity,

      toolMode: item.tool_mode ?? undefined,

      serviceTiers,
      defaultServiceTier: item.default_service_tier ?? undefined,
      additionalSpeedTiers: item.additional_speed_tiers,
    }
  }
}
