import React from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useConversationStore } from '../../stores/conversationStore'
import { EFFORT_LABELS } from '../../../shared/constants'

export function ReasoningSelector() {
  const models = useModelStore((s) => s.models)
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)

  const currentModelId = conversation?.defaultModelId ?? null
  const currentModel = models.find((m) => m.id === currentModelId) ?? null
  const currentEffort = conversation?.defaultReasoningEffort ?? null

  // 推理等级完全来自 supportedReasoningEfforts，禁止硬编码
  const efforts = currentModel?.supportedReasoningEfforts ?? []

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
    <div className="selector reasoning-selector">
      <select value={currentEffort ?? ''} onChange={(e) => handleChange(e.target.value)}>
        {efforts.map((effort) => (
          <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
            {label(effort.reasoningEffort)}
          </option>
        ))}
      </select>
    </div>
  )
}