import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useThemeStore } from '../../stores/themeStore'
import { MessageList } from './MessageList'
import { Composer } from '../composer/Composer'

const THEME_ICONS: Record<string, string> = {
  light: '\u2600',
  dark: '\u263E',
  system: '\u25D0',
}

export function ChatView() {
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const themeMode = useThemeStore((s) => s.mode)
  const cycleTheme = useThemeStore((s) => s.cycle)

  const themeLabel = themeMode === 'light' ? '浅色' : themeMode === 'dark' ? '深色' : '跟随系统'

  if (!activeConversation) {
    return (
      <div className="chat-view empty">
        <div className="empty-state">
          <h2>OpenChat Desktop</h2>
          <p>选择左侧对话或创建新对话开始聊天</p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        <span className="chat-title">{activeConversation.title}</span>
        <div className="chat-header-actions">
          <button
            className="theme-toggle-btn"
            onClick={cycleTheme}
            title={`当前主题：${themeLabel}`}
          >
            <span className="theme-toggle-icon">{THEME_ICONS[themeMode]}</span>
            <span>{themeLabel}</span>
          </button>
        </div>
      </div>
      <MessageList />
      <Composer />
    </div>
  )
}