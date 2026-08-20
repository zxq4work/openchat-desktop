import React, { useEffect, useCallback } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { useThemeStore } from '../../stores/themeStore'
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
  const themeMode = useThemeStore((s) => s.mode)
  const resolvedTheme = useThemeStore((s) => s.resolved)
  const cycleTheme = useThemeStore((s) => s.cycle)

  const themeLabel = themeMode === 'system'
    ? `跟随系统（${resolvedTheme === 'light' ? '浅色' : '深色'}）`
    : themeMode === 'light' ? '浅色' : '深色'
  const themeIcon = resolvedTheme === 'light' ? '☀' : '☾'

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
        {themeMode !== 'system' && (
          <button
            className="theme-toggle-btn sidebar-theme-btn"
            onClick={cycleTheme}
            title={`主题：${themeLabel}`}
            aria-label="切换主题"
          >
            <span className="theme-toggle-icon">{themeIcon}</span>
            <span>{themeLabel}</span>
          </button>
        )}
        <button className="settings-btn" onClick={() => setSettingsDialogOpen(true)}>
          ⚙ 设置
        </button>
      </div>
    </div>
  )
}