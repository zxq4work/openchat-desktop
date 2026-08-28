import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { Dropdown } from '../Dropdown'

const MODE_LABELS: Record<'hosted' | 'standalone', string> = {
  hosted: 'Codex Hosted',
  standalone: 'Codex Standalone',
}

export function CodexSearchModeSelector() {
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)

  // 仅在 Codex 原生提供商 + 已开启 web 搜索时显示
  if (!conversation) return null
  if (conversation.providerConfigId) return null
  if (!conversation.webSearchEnabled) return null

  const currentMode = conversation.codexSearchMode ?? 'hosted'

  const handleChange = async (mode: string) => {
    if (mode !== 'hosted' && mode !== 'standalone') return
    await window.openchat.conversations.updateCodexSearchMode(conversation.id, mode)
    setActiveConversation({ ...conversation, codexSearchMode: mode })
  }

  return (
    <Dropdown
      className="codex-search-mode-selector"
      value={currentMode}
      options={[
        { value: 'hosted', label: MODE_LABELS.hosted },
        { value: 'standalone', label: MODE_LABELS.standalone },
      ]}
      onChange={handleChange}
      ariaLabel="选择 Codex 搜索模式"
      title="Hosted：通过服务端 web_search 执行网页搜索&#10;Standalone：通过客户端提供的 web.run 执行网页搜索"
    />
  )
}
