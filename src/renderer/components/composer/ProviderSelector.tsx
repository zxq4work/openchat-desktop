import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'
import { Dropdown } from '../Dropdown'

const DEFAULT_OPTION_VALUE = '__openchat_default__'

export function ProviderSelector() {
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const providers = useProviderStore((s) => s.providers)

  if (!conversation) return null

  const currentProviderId = conversation.providerConfigId ?? DEFAULT_OPTION_VALUE

  const options = [
    { value: DEFAULT_OPTION_VALUE, label: 'ChatGPT Codex' },
    ...providers.map((p: SafeProviderConfig) => ({ value: p.id, label: p.name })),
  ]

  const handleChange = async (value: string) => {
    if (!conversation) return

    if (value === DEFAULT_OPTION_VALUE) {
      await window.openchat.conversations.updateProviderConfig(conversation.id, null)
      setActiveConversation({ ...conversation, providerConfigId: null })
    } else {
      const provider = providers.find((p) => p.id === value)
      await window.openchat.conversations.updateProviderConfig(conversation.id, value)

      // 切换为自定义服务时，模型同步为 provider 配置的第一个模型
      const firstModel = provider?.models?.[0]
      const updatedConv = {
        ...conversation,
        providerConfigId: value,
        defaultModelId: firstModel ?? conversation.defaultModelId,
      }
      if (firstModel) {
        await window.openchat.conversations.updateModel(conversation.id, firstModel)
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