import React, { useEffect } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useProviderStore } from '../../stores/providerStore'
import type { ModelInfo } from '../../../shared/types/model'
import { Dropdown, type DropdownOption } from '../Dropdown'
import { resolveConversationBinding, invalidBindingLabel, canUseProviderModels } from '../../../shared/conversation/capabilities'
import { visibleModels, resolveVisibleModel, resolveReasoningEffort, shouldClearModelForNoVisible } from '../../packages/modelPresentation'

export function ModelSelector() {
  const models = useModelStore((s) => s.models)
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const providers = useProviderStore((s) => s.providers)

  const currentModelId = conversation?.defaultModelId ?? null

  // 统一 binding 解析：会话类型权威（conversation.type），Provider 协议仅作兼容性约束。
  const binding = conversation
    ? resolveConversationBinding({
        conversationType: conversation.type,
        providerConfigId: conversation.providerConfigId,
        modelId: conversation.defaultModelId,
        providers,
      })
    : null

  const currentProvider = binding?.provider ?? null
  // 仅当当前 Provider 本身「可用」时才用它的模型列表：
  //   valid / unconfigured / model_missing → 用当前 Provider 的 models。
  // 关键：model_missing（Provider 有效、原模型失效）必须仍走自定义 Provider 路径，
  // 展示 synthetic 旧模型 + 该 Provider 其余可用模型；绝不能掉进 Codex 默认模型列表。
  // 仅 provider_missing / provider_incompatible（Provider 层失效）才不允许使用其 models；
  // provider_incompatible 时 provider 的 models 属于另一协议域（图片模型），绝不能列进 chat Select。
  const isCustomProvider = canUseProviderModels(currentProvider, binding?.status)

  // 仅在纯 Codex 路径（无 Provider 绑定）自动归一化当前模型：
  //   1. defaultModelId 为空（离线创建会话）→ 补第一个可见模型；
  //   2. defaultModelId 指向已 hidden / 从 catalog 消失的模型 → fallback 到第一个可见模型；
  //   3. catalog 非空但全部 hidden → 清空为「未选择模型」态，绝不继续以 hidden 模型发送。
  // 绝不替失效的历史绑定自动切换 Provider。
  // 仅在「确实需要变更」时写入，避免每次 render 写库 / 无限 useEffect loop。
  useEffect(() => {
    if (!conversation) return
    if (isCustomProvider) return
    if (binding && binding.status !== 'unconfigured') return
    if (models.length === 0) return

    // catalog 非空但全部 hidden：隐藏模型绝不继续可用 —— 把会话置回「未选择模型」态，
    // Main 侧 sendMessage 的 `if (!modelId) throw` 门禁随之生效，未选模型无法发送。
    if (shouldClearModelForNoVisible(models, conversation.defaultModelId)) {
      window.openchat.conversations.updateModel(conversation.id, null)
      window.openchat.conversations.updateEffort(conversation.id, '')
      setActiveConversation({ ...conversation, defaultModelId: null, defaultReasoningEffort: null })
      return
    }

    const resolved = resolveVisibleModel(models, conversation.defaultModelId)
    if (!resolved) return
    if (resolved.id === conversation.defaultModelId) return

    handleChange(resolved)
  }, [conversation?.id, conversation?.defaultModelId, isCustomProvider, models, binding?.status])

  const handleChange = (model: ModelInfo) => {
    if (!conversation) return
    // 从失效的历史绑定切到 Codex 默认路径：同步清空不兼容 / 已删除的 providerConfigId，
    // 否则 binding 仍停留在 provider_incompatible，发送门禁会继续拦截。
    const clearsProvider =
      !!conversation.providerConfigId &&
      (binding?.status === 'provider_incompatible' || binding?.status === 'provider_missing')
    if (clearsProvider) {
      window.openchat.conversations.updateProviderConfig(conversation.id, null)
    }
    window.openchat.conversations.updateModel(conversation.id, model.id)

    // 推理强度：统一复用 resolveReasoningEffort，绝不保留新模型不支持的旧 effort。
    const newEffort = resolveReasoningEffort(model, conversation.defaultReasoningEffort)

    window.openchat.conversations.updateEffort(conversation.id, newEffort ?? '')
    setActiveConversation({
      ...conversation,
      providerConfigId: clearsProvider ? null : conversation.providerConfigId,
      defaultModelId: model.id,
      defaultReasoningEffort: newEffort,
    })
  }

  // 失效绑定的 synthetic option：仅展示当前历史绑定，disabled 不允许重选。
  const buildInvalidOption = (): DropdownOption | null => {
    if (!conversation || !binding) return null
    if (binding.status === 'valid' || binding.status === 'unconfigured') return null
    const label = invalidBindingLabel({
      status: binding.status,
      conversationType: conversation.type,
      providerName: currentProvider?.name ?? conversation.providerNameSnapshot ?? null,
      modelName: conversation.modelNameSnapshot ?? conversation.defaultModelId,
    })
    if (!label) return null
    return { value: conversation.defaultModelId ?? '__invalid_binding__', label, disabled: true, invalid: true }
  }
  const invalidOption = buildInvalidOption()

  // 自定义服务模式：从 provider.models 构建可切换的下拉选项
  if (isCustomProvider && currentProvider) {
    const modelOptions: DropdownOption[] = (currentProvider.models || []).map((m) => ({
      value: m,
      label: m,
    }))
    const options: DropdownOption[] = invalidOption ? [invalidOption, ...modelOptions] : modelOptions

    const handleCustomModelChange = (modelId: string) => {
      if (!conversation) return
      window.openchat.conversations.updateModel(conversation.id, modelId)
      setActiveConversation({
        ...conversation,
        defaultModelId: modelId,
      })
    }

    return (
      <Dropdown
        className="model-selector"
        value={currentModelId ?? (currentProvider.models?.[0] || '')}
        placeholder="无模型"
        options={options}
        onChange={handleCustomModelChange}
        ariaLabel="选择模型"
      />
    )
  }

  // Codex 默认路径（无 Provider 绑定 / 历史 Provider 已失效）：
  // Provider 已删除或协议不兼容时，补 synthetic option 展示历史绑定，避免 Select 空白。
  const codexOptions: DropdownOption[] = visibleModels(models).map((model) => ({ value: model.id, label: model.displayName }))
  return (
    <Dropdown
      className="model-selector"
      value={currentModelId ?? ''}
      placeholder="无模型"
      options={invalidOption ? [invalidOption, ...codexOptions] : codexOptions}
      onChange={(id) => {
        const model = models.find((m) => m.id === id)
        if (model) handleChange(model)
      }}
      ariaLabel="选择模型"
    />
  )
}
