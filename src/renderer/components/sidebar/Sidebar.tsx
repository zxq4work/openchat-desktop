import React, { useEffect, useCallback } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { ConversationList } from './ConversationList'

export function Sidebar() {
  const summaries = useConversationStore((s) => s.summaries)
  const setSummaries = useConversationStore((s) => s.setSummaries)
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const setActiveMessages = useConversationStore((s) => s.setActiveMessages)
  const setActiveSegments = useConversationStore((s) => s.setActiveSegments)
  const setSettingsDialogOpen = useUiStore((s) => s.setSettingsDialogOpen)
  const models = useModelStore((s) => s.models)

  useEffect(() => {
    async function load() {
      const list = await window.openchat.conversations.list()
      setSummaries(list)
    }
    load()
  }, [setSummaries])

  const handleNewConversation = useCallback(async () => {
    const defaultModel = models.length > 0 ? models[0].id : null
    const defaultEffort = models.length > 0 && models[0].defaultReasoningEffort
      ? models[0].defaultReasoningEffort
      : models.length > 0 && models[0].supportedReasoningEfforts.length > 0
        ? models[0].supportedReasoningEfforts[0].reasoningEffort
        : null

    const conv = await window.openchat.conversations.create(defaultModel, defaultEffort)
    if (conv) {
      const list = await window.openchat.conversations.list()
      setSummaries(list)
      setActiveConversationId(conv.id)
      setActiveConversation(conv)
      setActiveMessages([])
      setActiveSegments([])
    }
  }, [models, setSummaries, setActiveConversationId, setActiveConversation, setActiveMessages, setActiveSegments])

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="new-conversation-btn" onClick={handleNewConversation}>
          + 新对话
        </button>
      </div>

      <ConversationList />

      <div className="sidebar-footer">
        <button className="settings-btn" onClick={() => setSettingsDialogOpen(true)}>
          ⚙ 设置
        </button>
      </div>
    </div>
  )
}