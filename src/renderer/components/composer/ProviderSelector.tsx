import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'
import { useModelStore } from '../../stores/modelStore'
import type { ModelInfo } from '../../../shared/types/model'
import { Dropdown, type DropdownOption } from '../Dropdown'
import { isChatProtocol, invalidBindingLabel } from '../../../shared/conversation/capabilities'

const DEFAULT_OPTION_VALUE = '__openchat_default__'

export function ProviderSelector() {
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const providers = useProviderStore((s) => s.providers)
  const codexModels = useModelStore((s) => s.models)

  if (!conversation) return null

  const currentProviderId = conversation.providerConfigId ?? DEFAULT_OPTION_VALUE

  // Chat 会话只能选择文字对话服务；图片生成服务在图片生成 Composer 中单独选择
  const chatProviders = providers.filter((p: SafeProviderConfig) => isChatProtocol(p.protocol))

  // 历史绑定失效：当前 providerConfigId 指向的 Provider 已不在 chat 列表中
  // （被删除，或协议被改为 image_generations）。此时补一个 disabled 的 synthetic option，
  // 仅用于展示当前历史绑定，避免 Select 空白；绝不把它混入正常可选项。
  const currentProvider = conversation.providerConfigId
    ? providers.find((p) => p.id === conversation.providerConfigId) ?? null
    : null
  const bindingInvalid = !!conversation.providerConfigId && (!currentProvider || !isChatProtocol(currentProvider.protocol))

  const options: DropdownOption[] = []
  if (bindingInvalid) {
    const label = invalidBindingLabel({
      status: currentProvider ? 'provider_incompatible' : 'provider_missing',
      conversationType: conversation.type,
      providerName: currentProvider?.name ?? conversation.providerNameSnapshot ?? null,
      modelName: conversation.modelNameSnapshot ?? conversation.defaultModelId,
    })
    options.push({ value: conversation.providerConfigId as string, label, disabled: true, invalid: true })
  }
  options.push({ value: DEFAULT_OPTION_VALUE, label: 'ChatGPT Codex' })
  options.push(...chatProviders.map((p: SafeProviderConfig) => ({ value: p.id, label: p.name })))

  // 由目标 provider 的模型列表推导「切换后应采用的模型 + 推理强度」。
  // 两种情况都必须重算，否则会保留上一个 provider 域下的旧模型 id：
  //   自定义 provider → 使用该 provider 配置的第一个模型，推理强度按新模型能力修正；
  //   切回 ChatGPT Codex → 使用 Codex 模型列表的第一个模型，推理强度按该模型能力修正。
  // 旧模型 id 若不属于新域，ModelSelector 无法匹配 → 显示占位「无模型」，
  // 而列表里其实存在可选模型（本 bug 的根因）。
  const supportedEffortsOf = (m: ModelInfo | null): string[] =>
    m?.supportedReasoningEfforts.map((e) => e.reasoningEffort) ?? []

  const resolveSwitchModel = (
    firstModel: ModelInfo | null,
    prevEffort: string | null
  ): { modelId: string | null; effort: string | null } => {
    const supported = supportedEffortsOf(firstModel)
    let effort: string | null = null
    if (prevEffort && supported.includes(prevEffort)) {
      effort = prevEffort
    } else if (firstModel?.defaultReasoningEffort && supported.includes(firstModel.defaultReasoningEffort)) {
      effort = firstModel.defaultReasoningEffort
    } else if (supported.length > 0) {
      effort = supported[0]
    }
    return { modelId: firstModel?.id ?? null, effort }
  }

  const handleChange = async (value: string) => {
    if (!conversation) return

    if (value === DEFAULT_OPTION_VALUE) {
      // 切回 ChatGPT Codex：必须同步切到 Codex 模型列表的第一个模型。
      // 之前只清空 providerConfigId，defaultModelId 仍是自定义 provider 的模型 id，
      // binding 变为 unconfigured 后走 Codex 路径却匹配不到该 id → 「无模型」。
      const firstModel = codexModels.length > 0 ? codexModels[0] : null
      const { modelId, effort } = resolveSwitchModel(firstModel, conversation.defaultReasoningEffort)
      await window.openchat.conversations.updateProviderConfig(conversation.id, null)
      if (modelId) {
        await window.openchat.conversations.updateModel(conversation.id, modelId)
      }
      await window.openchat.conversations.updateEffort(conversation.id, effort ?? '')
      setActiveConversation({
        ...conversation,
        providerConfigId: null,
        defaultModelId: modelId ?? conversation.defaultModelId,
        defaultReasoningEffort: effort,
      })
    } else {
      const provider = chatProviders.find((p) => p.id === value)
      await window.openchat.conversations.updateProviderConfig(conversation.id, value)

      // 切换为自定义服务时，模型同步为 provider 配置的第一个模型。
      // 自定义 provider 的模型只带 id（无 ModelInfo），推理强度沿用现有值，不强行改写。
      const firstModelId = provider?.models?.[0]
      const updatedConv = {
        ...conversation,
        providerConfigId: value,
        defaultModelId: firstModelId ?? conversation.defaultModelId,
      }
      if (firstModelId) {
        await window.openchat.conversations.updateModel(conversation.id, firstModelId)
      }
      setActiveConversation(updatedConv)
    }
  }

  return (
    <Dropdown
      className="provider-selector"
      value={currentProviderId}
      placeholder="选择服务"
      options={options}
      onChange={handleChange}
      ariaLabel="选择模型服务"
    />
  )
}
