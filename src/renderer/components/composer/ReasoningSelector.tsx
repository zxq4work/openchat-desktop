import React, { useEffect } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useProviderStore } from '../../stores/providerStore'
import { EFFORT_LABELS } from '../../../shared/constants'
import { Dropdown } from '../Dropdown'
import { resolveConversationBinding } from '../../../shared/conversation/capabilities'

// 自定义供应商 Chat Completions API 支持的推理等级
const CUSTOM_REASONING_EFFORTS = [
  { reasoningEffort: 'none', description: 'No reasoning' },
  { reasoningEffort: 'minimal', description: 'Minimal reasoning' },
  { reasoningEffort: 'low', description: 'Low reasoning' },
  { reasoningEffort: 'medium', description: 'Medium reasoning' },
  { reasoningEffort: 'high', description: 'High reasoning' },
  { reasoningEffort: 'xhigh', description: 'Extra high reasoning' },
]

export function ReasoningSelector() {
  const models = useModelStore((s) => s.models)
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const providers = useProviderStore((s) => s.providers)

  const currentModelId = conversation?.defaultModelId ?? null
  const currentModel = models.find((m) => m.id === currentModelId) ?? null
  const currentEffort = conversation?.defaultReasoningEffort ?? null
  const isCustomProvider = !!conversation?.providerConfigId

  // binding 失效（Provider 被删除/改协议，或 Model 不存在）时，依赖当前 Model capability
  // 的控件应禁用编辑，但**绝不清空已保存的值**，等待 binding 恢复后被还原。
  const binding = conversation
    ? resolveConversationBinding({
        conversationType: conversation.type,
        providerConfigId: conversation.providerConfigId,
        modelId: conversation.defaultModelId,
        providers,
      })
    : null
  const bindingInvalid = !!binding && binding.status !== 'valid' && binding.status !== 'unconfigured'

  // Codex 模型：推理等级来自 supportedReasoningEfforts
  // 自定义供应商：使用 Chat Completions 标准推理等级
  const efforts = isCustomProvider
    ? CUSTOM_REASONING_EFFORTS
    : (currentModel?.supportedReasoningEfforts ?? [])

  // 如果会话有模型但没有设置推理等级，自动补上默认等级。
  // binding 失效时不做此自动补值（依赖当前 Model capability，语义不成立）。
  useEffect(() => {
    if (!conversation) return
    if (bindingInvalid) return
    if (conversation.defaultReasoningEffort) return
    if (efforts.length === 0) return

    const defaultEffort =
      (currentModel?.defaultReasoningEffort && efforts.some((e) => e.reasoningEffort === currentModel.defaultReasoningEffort)
        ? currentModel.defaultReasoningEffort
        : null) ?? efforts[0].reasoningEffort

    window.openchat.conversations.updateEffort(conversation.id, defaultEffort)
    setActiveConversation({ ...conversation, defaultReasoningEffort: defaultEffort })
  }, [conversation?.id, isCustomProvider ? 'custom' : currentModel?.id, efforts.length, bindingInvalid])

  // 保留绑定值：失效期间只展示已保存 effort，保证 Select 不空白且不误导可选集合。
  const optionSource = bindingInvalid
    ? (currentEffort ? [{ reasoningEffort: currentEffort, description: '' }] : [])
    : efforts

  // 无任何可展示选项时不渲染控件。
  if (optionSource.length === 0) {
    return null
  }

  const handleChange = (effort: string) => {
    if (!conversation) return
    window.openchat.conversations.updateEffort(conversation.id, effort)
    setActiveConversation({ ...conversation, defaultReasoningEffort: effort })
  }

  const label = (id: string) => EFFORT_LABELS[id] ?? id

  return (
    <Dropdown
      className="reasoning-selector"
      value={currentEffort ?? ''}
      options={optionSource.map((effort) => ({
        value: effort.reasoningEffort,
        label: label(effort.reasoningEffort),
      }))}
      onChange={handleChange}
      disabled={bindingInvalid}
      ariaLabel="选择推理强度"
      title={bindingInvalid ? '请先选择可用模型' : undefined}
    />
  )
}
