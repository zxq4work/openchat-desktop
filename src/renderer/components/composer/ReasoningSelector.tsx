import React, { useEffect } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useConversationStore } from '../../stores/conversationStore'
import { EFFORT_LABELS } from '../../../shared/constants'
import { Dropdown } from '../Dropdown'

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

  const currentModelId = conversation?.defaultModelId ?? null
  const currentModel = models.find((m) => m.id === currentModelId) ?? null
  const currentEffort = conversation?.defaultReasoningEffort ?? null
  const isCustomProvider = !!conversation?.providerConfigId

  // Codex 模型：推理等级来自 supportedReasoningEfforts
  // 自定义供应商：使用 Chat Completions 标准推理等级
  const efforts = isCustomProvider
    ? CUSTOM_REASONING_EFFORTS
    : (currentModel?.supportedReasoningEfforts ?? [])

  // 如果会话有模型但没有设置推理等级，自动补上默认等级
  useEffect(() => {
    if (!conversation) return
    if (conversation.defaultReasoningEffort) return
    if (efforts.length === 0) return

    const defaultEffort =
      (currentModel?.defaultReasoningEffort && efforts.some((e) => e.reasoningEffort === currentModel.defaultReasoningEffort)
        ? currentModel.defaultReasoningEffort
        : null) ?? efforts[0].reasoningEffort

    window.openchat.conversations.updateEffort(conversation.id, defaultEffort)
    setActiveConversation({ ...conversation, defaultReasoningEffort: defaultEffort })
  }, [conversation?.id, isCustomProvider ? 'custom' : currentModel?.id, efforts.length])

  if (efforts.length === 0) {
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
      options={efforts.map((effort) => ({
        value: effort.reasoningEffort,
        label: label(effort.reasoningEffort),
      }))}
      onChange={handleChange}
      ariaLabel="选择推理强度"
    />
  )
}