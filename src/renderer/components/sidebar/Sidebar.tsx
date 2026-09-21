import React, { useEffect, useCallback, useRef, useState } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
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
  const providers = useProviderStore((s) => s.providers)
  const themeMode = useThemeStore((s) => s.mode)
  const resolvedTheme = useThemeStore((s) => s.resolved)
  const cycleTheme = useThemeStore((s) => s.cycle)

  // 「新对话」拆分为主按钮（新建聊天）+ 下拉箭头（可新建图片生成会话）。
  const [menuOpen, setMenuOpen] = useState(false)
  const newBtnRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (newBtnRef.current && !newBtnRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

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

  const handleNewConversation = useCallback(async (type: 'chat' | 'image_generation' = 'chat') => {
    // 若当前活跃会话是空白且类型相同，直接复用，不新建
    const store = useConversationStore.getState()
    if (store.activeConversationId && store.activeMessages.length === 0) {
      if (store.activeConversation?.type === type) {
        useUiStore.getState().requestComposerFocus()
        return
      }
      // 类型不同：不允许在同一空会话上切换类型（保持语义清晰），新建一个
    }

    if (type === 'image_generation') {
      // 图片生成会话：默认使用第一个图片生成服务及其首个模型
      const imageProvider = providers.find((p) => p.protocol === 'image_generations')
      const conv = await window.openchat.conversations.create(
        imageProvider?.models?.[0] ?? null,
        null,
        undefined,
        imageProvider?.id ?? null,
        false,
        undefined,
        'image_generation'
      )
      if (conv) {
        const newList = await window.openchat.conversations.list()
        setSummaries(newList)
        setActiveConversationId(conv.id)
        setActiveConversation(conv)
        setActiveMessages([])
        setActiveSegments([])
      }
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

    const conv = await window.openchat.conversations.create(defaultModel, defaultEffort, undefined, saved.providerId, defaultWebSearch, defaultSearchEngine, 'chat')
    if (conv) {
      const newList = await window.openchat.conversations.list()
      setSummaries(newList)
      setActiveConversationId(conv.id)
      setActiveConversation(conv)
      setActiveMessages([])
      setActiveSegments([])
    }
  }, [models, providers, setSummaries, setActiveConversationId, setActiveConversation, setActiveMessages, setActiveSegments])

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="new-conversation-split" ref={newBtnRef}>
          <button className="new-conversation-btn" onClick={() => handleNewConversation('chat')}>
            + 新对话
          </button>
          <button
            className="new-conversation-caret"
            onClick={() => setMenuOpen((v) => !v)}
            title="更多新建选项"
            aria-label="更多新建选项"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {menuOpen && (
            <div className="new-conversation-menu" role="menu">
              <button
                className="new-conversation-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void handleNewConversation('chat')
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                新建聊天
              </button>
              <button
                className="new-conversation-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void handleNewConversation('image_generation')
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                新建图片生成
              </button>
            </div>
          )}
        </div>
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