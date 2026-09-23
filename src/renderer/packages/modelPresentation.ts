import type { ModelInfo, SupportedReasoningEffort } from '../../shared/types/model'

// 模型下拉可选项：只展示非 hidden 模型。服务器未声明 visibility 时 hidden=false，保持可见。
export function visibleModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => !m.hidden)
}

// 从候选模型中解析「当前有效」的可见模型：
//   1. requestedModelId 存在于 visible → 返回它
//   2. 否则 → 第一个 visible
//   3. 无任何 visible → null（绝不回退到 hidden / models[0]）
// 用于：新建会话、切换 Provider、active 会话当前模型已 hidden/missing 时的 fallback。
export function resolveVisibleModel(
  models: ModelInfo[],
  requestedModelId?: string | null
): ModelInfo | null {
  const visible = visibleModels(models)
  if (requestedModelId) {
    const requested = visible.find((m) => m.id === requestedModelId)
    if (requested) return requested
  }
  return visible[0] ?? null
}

// 为某个模型解析「实际要使用的 reasoning effort」，绝不返回模型不支持的 preferred/default。
// CASE A（supported 非空，服务器已给可用集合）：
//   preferred ∈ supported → preferred；否则 default ∈ supported → default；否则 supported[0]。
// CASE B（supported 为空，服务器未给足够信息）：不把「未知」当作「不支持」，
//   保持 forward compatibility：preferred 非空 → preferred；否则 default 非空 → default；否则 null。
export function resolveReasoningEffort(
  model: ModelInfo,
  preferred?: string | null
): string | null {
  const supported = model.supportedReasoningEfforts
    .map((e) => e.reasoningEffort)
    .filter((e) => !!e)

  if (supported.length > 0) {
    if (preferred && supported.includes(preferred)) return preferred
    if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
      return model.defaultReasoningEffort
    }
    return supported[0]
  }

  if (preferred) return preferred
  if (model.defaultReasoningEffort) return model.defaultReasoningEffort
  return null
}

export interface SavedModelDefaults {
  providerId: string | null
  modelId: string | null
  effort: string | null
}

export interface NewConversationDefaults {
  modelId: string | null
  effort: string | null
}

// 新建会话时的默认模型 / 推理强度解析。模型域严格按 providerId 区分：
//   自定义 Provider（providerId 非空）：saved.modelId / saved.effort 属于该 Provider 自己的
//     模型域（qwen / deepseek / glm / 任意 OpenAI-compatible 模型名），
//     Codex catalog 与它无关 —— 必须原样沿用，绝不能用 Codex 模型覆盖（否则会造成非法 binding）。
//   ChatGPT Codex（providerId 为空）：saved.modelId 可能已 hidden / 从 catalog 消失，
//     用 Codex catalog 归一化到第一个可见模型；无可见模型时返回 null（不偷偷使用 hidden 模型）。
export function resolveNewConversationDefaults(
  codexModels: ModelInfo[],
  saved: SavedModelDefaults
): NewConversationDefaults {
  // providerId 为真值才走自定义 Provider（与 resolveConversationBinding 的 !providerConfigId 语义一致；
  // null / undefined / '' 一律视为 ChatGPT Codex 默认 Provider）。
  if (saved.providerId) {
    return { modelId: saved.modelId, effort: saved.effort }
  }
  const model = resolveVisibleModel(codexModels, saved.modelId)
  return {
    modelId: model?.id ?? null,
    effort: model ? resolveReasoningEffort(model, saved.effort) : null,
  }
}

// 纯 Codex 会话当前绑定的模型是否必须被清空为「未选择模型」态：
//   catalog 尚未加载（models 为空）→ 不清（无法判断）；
//   当前已无模型 → 不清（已是目标态）；
//   否则当且仅当「无任何可见模型」时清空。
// 用于：全部 Codex 模型 hidden 时，绝不继续以 hidden model 发送（Main 侧 `!modelId` 门禁随之生效）。
export function shouldClearModelForNoVisible(
  models: ModelInfo[],
  currentModelId: string | null
): boolean {
  if (models.length === 0) return false
  if (currentModelId == null) return false
  return resolveVisibleModel(models, currentModelId) === null
}

// 已知 reasoning effort 的短名称。
// 键为服务器返回的 raw effort（wire value），值为紧凑 UI 名称。
// 服务器 description（如 "Balances speed and reasoning depth for everyday tasks"）
// 仅作辅助解释/tooltip，绝不作为名称。
const KNOWN_REASONING_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
  persistent: 'Persistent',
}

// 未知 effort 的稳定 humanize：下划线/连字符转空格、合并连续空格、每词首字母大写。
// 只影响展示，绝不修改原始 effort 值（wire value 必须原样透传）。
export function humanizeReasoningEffort(effort: string): string {
  return effort
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}

// reasoning effort 的短名称。仅依据 raw effort 生成，绝不使用服务器 description。
// 未知/未来 effort 一律 humanize 后展示，绝不因不识别而过滤或丢弃。
export function reasoningEffortLabel(effort: string): string {
  const normalized = effort.trim()
  if (!normalized) return ''
  const known = KNOWN_REASONING_LABELS[normalized.toLowerCase()]
  if (known) return known
  return humanizeReasoningEffort(normalized)
}

// 把 supportedReasoningEfforts 映射为下拉选项：
//   value = raw effort（wire value，选中/发送都用它）
//   label = 短名称（reasoningEffortLabel(effort)）
//   description = 服务器 description（仅作 tooltip，绝不作为主文本或选中值）
// 未知 effort 原样保留；description 完整保留。
export function reasoningEffortOptions(
  efforts: SupportedReasoningEffort[]
): Array<{ value: string; label: string; description?: string }> {
  return efforts.map((e) => ({
    value: e.reasoningEffort,
    label: reasoningEffortLabel(e.reasoningEffort),
    description: e.description ?? undefined,
  }))
}
