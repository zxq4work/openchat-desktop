import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { Dropdown } from '../Dropdown'

const ENGINE_LABELS: Record<'bing' | 'baidu' | 'google', string> = {
  bing: 'Bing',
  baidu: '百度',
  google: 'Google',
}

export function SearchEngineSelector() {
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)

  // 仅在自定义 Provider + 已开启 web 搜索时显示
  if (!conversation) return null
  if (!conversation.providerConfigId) return null
  if (!conversation.webSearchEnabled) return null

  const currentEngine = conversation.searchEngine ?? 'bing'

  const handleChange = async (engine: string) => {
    if (engine !== 'bing' && engine !== 'baidu' && engine !== 'google') return
    await window.openchat.conversations.updateSearchEngine(conversation.id, engine)
    setActiveConversation({ ...conversation, searchEngine: engine })
  }

  return (
    <Dropdown
      className="search-engine-selector"
      value={currentEngine}
      options={[
        { value: 'bing', label: ENGINE_LABELS.bing },
        { value: 'baidu', label: ENGINE_LABELS.baidu },
        { value: 'google', label: ENGINE_LABELS.google },
      ]}
      onChange={handleChange}
      ariaLabel="选择搜索引擎"
      title="自定义 Provider 使用的网页搜索引擎"
    />
  )
}
