import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useCodexUsageStore, isCodexExhausted } from '../../stores/codexUsageStore'

export function WebSearchToggle() {
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const usage = useCodexUsageStore((s) => s.usage)
  const exhausted = isCodexExhausted(usage)
  // 使用自定义服务时，忽略 Codex 额度限制
  const isExhausted = exhausted && !activeConversation?.providerConfigId

  const webSearchEnabled = activeConversation?.webSearchEnabled ?? false

  // 搜索开关对所有 Provider 开放（Codex / Compatible / Responses）
  if (!activeConversation) return null

  const handleToggle = async () => {
    if (isExhausted) return
    const newValue = !webSearchEnabled
    await window.openchat.conversations.updateWebSearchEnabled(activeConversation.id, newValue)
    const data = await window.openchat.conversations.get(activeConversation.id)
    if (data) {
      useConversationStore.getState().setActiveConversation(data.conversation)
    }
  }

  const title = isExhausted
    ? 'Codex 额度已用尽，恢复后可继续联网搜索'
    : activeConversation?.providerConfigId
      ? (webSearchEnabled ? 'OpenChat 网页搜索（已开启）' : 'OpenChat 网页搜索')
      : (webSearchEnabled
          ? (activeConversation.codexSearchMode === 'standalone' ? 'Codex Standalone（已开启）' : 'Codex Hosted（已开启）')
          : (activeConversation.codexSearchMode === 'standalone' ? 'Codex Standalone' : 'Codex Hosted'))

  return (
    <button
      className={`web-search-toggle ${webSearchEnabled ? 'web-search-toggle-on' : ''}`}
      onClick={handleToggle}
      disabled={isExhausted}
      title={title}
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
