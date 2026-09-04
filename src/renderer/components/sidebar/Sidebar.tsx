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

  useEffect(() => {
    async function load() {
      const list = await window.openchat.conversations.list()
      setSummaries(list)
    }
    load()
  }, [setSummaries])

  const handleNewConversation = useCallback(async () => {
    // 若当前活跃会话是空白的（无消息），直接复用，不新建
    const store = useConversationStore.getState()
    if (store.activeConversationId && store.activeMessages.length === 0) {
      useUiStore.getState().requestComposerFocus()
      return
    }

    const saved = await window.openchat.settings.getDefaultModel()
    const defaultWebSearch = await window.openchat.settings.getDefaultWebSearch()
    const defaultSearchEngine = await window.openchat.settings.getWebSearchEngine()

    let defaultModel = saved.modelId
    let defaultEffort = saved.effort

    if (!defaultModel && models.length > 0) {
      defaultModel = models[0].id
    }
    if (!defaultEffort && models.length > 0) {
      defaultEffort = models[0].defaultReasoningEffort
        ?? (models[0].supportedReasoningEfforts.length > 0
          ? models[0].supportedReasoningEfforts[0].reasoningEffort
          : null)
    }

    const conv = await window.openchat.conversations.create(defaultModel, defaultEffort, undefined, saved.providerId, defaultWebSearch, defaultSearchEngine)
    if (conv) {
      const newList = await window.openchat.conversations.list()
      setSummaries(newList)
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
            {resolvedTheme === 'light' ? (
              <svg className="theme-toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg className="theme-toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
            <span>{themeLabel}</span>
          </button>
        )}
        <button className="settings-btn" onClick={() => setSettingsDialogOpen(true)}>
          <svg
            className="settings-btn-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          设置
        </button>
      </div>
    </div>
  )
}