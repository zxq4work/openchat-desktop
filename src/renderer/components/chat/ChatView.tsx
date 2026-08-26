import React, { useEffect } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'
import { MessageList } from './MessageList'
import { Composer } from '../composer/Composer'
import { SearchBar } from './SearchBar'

export function ChatView() {
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const searchVisible = useUiStore((s) => s.searchVisible)
  const closeSearch = useUiStore((s) => s.closeSearch)

  // 切换对话时关闭搜索栏
  useEffect(() => {
    closeSearch()
  }, [activeConversationId, closeSearch])

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
      </div>
      {searchVisible && <SearchBar />}
      <MessageList />
      <Composer />
    </div>
  )
}