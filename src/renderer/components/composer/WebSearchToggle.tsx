import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useModelStore } from '../../stores/modelStore'

export function WebSearchToggle() {
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const models = useModelStore((s) => s.models)

  const webSearchEnabled = activeConversation?.webSearchEnabled ?? false

  // 检查当前模型是否支持 web search
  const currentModel = activeConversation?.defaultModelId
    ? models.find((m) => m.id === activeConversation.defaultModelId)
    : null
  const webSearchSupported = currentModel?.webSearchToolType != null

  if (!activeConversation || !webSearchSupported) return null

  const handleToggle = async () => {
    const newValue = !webSearchEnabled
    await window.openchat.conversations.updateWebSearchEnabled(activeConversation.id, newValue)
    // 刷新本地状态
    const data = await window.openchat.conversations.get(activeConversation.id)
    if (data) {
      useConversationStore.getState().setActiveConversation(data.conversation)
    }
  }

  return (
    <button
      className={`web-search-toggle ${webSearchEnabled ? 'web-search-toggle-on' : ''}`}
      onClick={handleToggle}
      title={webSearchEnabled ? '关闭网页搜索' : '开启网页搜索'}
    >
      <svg className="web-search-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      <span className="web-search-toggle-label">搜索</span>
    </button>
  )
}