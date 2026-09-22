// 会话能力判定（纯函数，主进程与渲染进程共享）。
// 核心设计原则：
//   Conversation modality is authoritative.
//   Provider capability is only a compatibility constraint.
// 即：conversation.type 决定「这个会话是什么类型」；
//     provider.protocol 只决定「这个 Provider 当前能不能服务这个会话」。
// 绝不通过 provider 当前 protocol 反向推导 / 覆盖 conversation 的类型。
import type { ConversationType } from '../types/conversation'

// 聊天协议：走 ModelAdapter 的文字对话协议（含 Codex 原生）。
// image_generations 是唯一非聊天协议。
const CHAT_PROTOCOLS: ReadonlySet<string> = new Set(['chatgpt_codex', 'chat_completions', 'responses'])

export function isChatProtocol(protocol: string | null | undefined): boolean {
  return !!protocol && CHAT_PROTOCOLS.has(protocol)
}

export function isImageProtocol(protocol: string | null | undefined): boolean {
  return protocol === 'image_generations'
}

// Provider 当前协议能否服务某类型的会话。
export function isProtocolCompatibleWithConversation(
  protocol: string | null | undefined,
  conversationType: ConversationType
): boolean {
  if (conversationType === 'image_generation') return isImageProtocol(protocol)
  return isChatProtocol(protocol)
}

// 当前 Provider 的 models 列表是否可用于会话的 Select。
// 只有「Provider 层失效」才禁止使用其 models：
//   provider_missing（Provider 已删除）/ provider_incompatible（协议已不兼容，models 属于另一协议域）。
// 「Model 层失效」（model_missing）时 Provider 本身仍有效，必须继续展示其剩余 models，
// 否则会错误掉进 Codex 默认列表（chat）或丢失可选的图片模型（image）。
export function canUseProviderModels(
  provider: BindingProviderLike | null,
  status: ConversationBindingStatus | null | undefined
): boolean {
  if (!provider || !status) return false
  return status !== 'provider_missing' && status !== 'provider_incompatible'
}

// 图片参数（size/quality/background/outputFormat）是否可编辑。
// 只有 binding 完全 valid（Provider + Model 均有效）时才允许改动。
// model_missing / provider_missing / provider_incompatible / unconfigured 一律禁止：
// 这些状态下参数的实际可用性由「原 Provider 的 Image Profile」决定，但该 Profile 已不再是
// 一个可安全编辑的上下文 —— 尤其 provider_incompatible（Provider 协议已改成 chat）时
// DB 仍可能残留旧的 image_generation_profile_json，若不按 binding 拦截，旧 Profile 会继续驱动 UI。
// 禁止编辑不代表清空：会话中已保存的参数值原样保留，binding 恢复 valid 后自动重新可编辑。
export function canEditImageParams(status: ConversationBindingStatus | null | undefined): boolean {
  return status === 'valid'
}

// ── 会话 Binding 解析 ──
// 统一计算「会话当前绑定的 Provider/Model 是否依然可用」，供 Select 与发送校验复用。
export type ConversationBindingStatus =
  | 'unconfigured'          // 从未绑定 Provider（新会话），非错误，UI 语义为「请选择模型」
  | 'valid'                 // Provider 存在、协议兼容、Model 存在
  | 'provider_missing'      // Provider 已删除
  | 'provider_incompatible' // Provider 存在，但协议与会话类型不兼容（历史绑定失效）
  | 'model_missing'         // Provider 兼容，但绑定的 Model 已不可用

export interface BindingProviderLike {
  id: string
  name: string
  protocol: string
  models?: string[]
}

export interface ResolvedConversationBinding {
  status: ConversationBindingStatus
  // Provider 存在且协议兼容时的实时 Provider（用于展示实时名称 / 构建兼容选项）
  provider: BindingProviderLike | null
  // 当前绑定（或实时解析）的 Model
  modelId: string | null
}

export interface ResolveBindingInput {
  conversationType: ConversationType
  providerConfigId: string | null
  modelId: string | null
  providers: BindingProviderLike[]
}

// 解析会话当前 binding。绝不读取或修改 conversation.type。
export function resolveConversationBinding(input: ResolveBindingInput): ResolvedConversationBinding {
  const { conversationType, providerConfigId, modelId, providers } = input

  // 无 Provider 绑定 → 默认 Codex（chat）或未配置（image）。
  // 这是「从未绑定」，不是「历史失效」，UI 走全新会话的引导态。
  if (!providerConfigId) {
    return { status: 'unconfigured', provider: null, modelId }
  }

  const provider = providers.find((p) => p.id === providerConfigId) ?? null
  if (!provider) {
    return { status: 'provider_missing', provider: null, modelId }
  }

  if (!isProtocolCompatibleWithConversation(provider.protocol, conversationType)) {
    return { status: 'provider_incompatible', provider, modelId }
  }

  // Provider 兼容即视为「有效绑定」（协议层面可用）。
  // 尚未选择模型（modelId 为空）是「待选择」而非「失效」，不报错、不阻止浏览。
  // 仅当 Provider 明确给出了模型列表、且已绑定的具体模型不在其中时，才判定为 model_missing；
  // 模型列表为空时不据此判失效（避免把能用的配置误伤）。
  const models = provider.models ?? []
  if (modelId && models.length > 0 && !models.includes(modelId)) {
    return { status: 'model_missing', provider, modelId }
  }

  return { status: 'valid', provider, modelId }
}

// ── 失效 binding 的用户提示文案（发送前校验 / Select 附近提示复用） ──
// 这些文案的语义全部以 conversation.type 为准，绝不出现「会话已锁定为图片生成」。
export function bindingBlockedMessage(
  status: ConversationBindingStatus,
  conversationType: ConversationType
): string {
  if (conversationType === 'image_generation') {
    switch (status) {
      case 'provider_missing':
        return '原图片供应商已不可用，请重新选择图片生成服务。'
      case 'provider_incompatible':
        return '当前会话是图片生成会话，但原供应商已不再支持图片生成，请重新选择图片生成服务。'
      case 'model_missing':
        return '原图片模型已不可用，请重新选择一个图片模型。'
      default:
        return '请先为本会话选择图片生成服务。'
    }
  }
  switch (status) {
    case 'provider_missing':
      return '原聊天供应商已不可用，请重新选择聊天模型。'
    case 'provider_incompatible':
      return '当前会话是聊天会话，但原供应商已不再支持聊天，请重新选择聊天模型。'
    case 'model_missing':
      return '原模型已不可用，请重新选择一个聊天模型。'
    default:
      return '请先为本会话选择模型。'
  }
}

// ── Select 失效选项文案 ──
// 历史 Provider 存在但协议不兼容 / 已删除 / Model 已删除时，构建 synthetic option 的标签。
export interface InvalidBindingLabelInput {
  status: ConversationBindingStatus
  conversationType: ConversationType
  // 实时 Provider（存在时）或其名称快照
  providerName: string | null
  // 当前绑定 Model 名（无名称时回退 id）
  modelName: string | null
}

export function invalidBindingLabel(input: InvalidBindingLabelInput): string {
  const { status, conversationType } = input
  const providerName = input.providerName?.trim() || null
  const modelName = input.modelName?.trim() || null

  switch (status) {
    case 'provider_incompatible':
      if (providerName) {
        return conversationType === 'image_generation'
          ? `${providerName}（已改为聊天协议）`
          : `${providerName}（已改为图片生成）`
      }
      return conversationType === 'image_generation'
        ? '原供应商（已改为聊天协议）'
        : '原供应商（已改为图片生成）'
    case 'provider_missing':
      return providerName ? `${providerName}（供应商已删除）` : '原供应商已删除'
    case 'model_missing':
      if (providerName && modelName) return `${providerName} / ${modelName}（模型已不可用）`
      return '原模型（模型已不可用）'
    default:
      return ''
  }
}
