import React, { useEffect } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useConversationStore } from '../../stores/conversationStore'
import type { ModelInfo } from '../../../shared/types/model'
import { Dropdown } from '../Dropdown'

export function ModelSelector() {
  const models = useModelStore((s) => s.models)
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)

  const currentModelId = conversation?.defaultModelId ?? null
  const currentModel = models.find((m) => m.id === currentModelId) ?? null

  // 如果在离线状态下创建会话导致 defaultModelId 为空，恢复网络后自动补上默认模型
  useEffect(() => {
    if (!conversation) return
    if (conversation.defaultModelId) return
    if (models.length === 0) return

    const defaultModel = models[0]
    handleChange(defaultModel)
  }, [conversation?.id, models])

  const handleChange = (model: ModelInfo) => {
    if (!conversation) return
    window.openchat.conversations.updateModel(conversation.id, model.id)

    // 推理强度修正
    const prevEffort = conversation.defaultReasoningEffort
    const supported = model.supportedReasoningEfforts.map((s) => s.reasoningEffort)
    let newEffort: string | null = null

    if (prevEffort && supported.includes(prevEffort)) {
      newEffort = prevEffort
    } else if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
      newEffort = model.defaultReasoningEffort
    } else if (supported.length > 0) {
      newEffort = supported[0]
    }

    window.openchat.conversations.updateEffort(conversation.id, newEffort ?? '')
    setActiveConversation({
      ...conversation,
      defaultModelId: model.id,
      defaultReasoningEffort: newEffort,
    })
  }

  return (
    <Dropdown
      className="model-selector"
      value={currentModelId ?? ''}
      placeholder="无模型"
      options={models.map((model) => ({ value: model.id, label: model.displayName }))}
      onChange={(id) => {
        const model = models.find((m) => m.id === id)
        if (model) handleChange(model)
      }}
      ariaLabel="选择模型"
    />
  )
}