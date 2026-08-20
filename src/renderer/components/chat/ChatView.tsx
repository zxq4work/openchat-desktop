import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { MessageList } from './MessageList'
import { Composer } from '../composer/Composer'

export function ChatView() {
  const activeConversation = useConversationStore((s) => s.activeConversation)

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
      <MessageList />
      <Composer />
    </div>
  )
}