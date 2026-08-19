import React from 'react'
import type { ConversationSummary } from '../../../shared/types/conversation'
import { useConversationStore } from '../../stores/conversationStore'

interface Props {
  summary: ConversationSummary
  active: boolean
}

export function ConversationItem({ summary, active }: Props) {
  const setSummaries = useConversationStore((s) => s.setSummaries)
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const setActiveMessages = useConversationStore((s) => s.setActiveMessages)
  const setActiveSegments = useConversationStore((s) => s.setActiveSegments)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)

  const handleClick = async () => {
    setActiveConversationId(summary.id)
    const data = await window.openchat.conversations.get(summary.id)
    if (data) {
      setActiveConversation(data.conversation)
      setActiveMessages(data.messages)
      setActiveSegments(data.segments)
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await window.openchat.conversations.remove(summary.id)

    // 如果删除的是当前激活的会话，清空激活状态
    if (activeConversationId === summary.id) {
      setActiveConversationId(null)
      setActiveConversation(null)
      setActiveMessages([])
      setActiveSegments([])
    }

    // 刷新列表
    const list = await window.openchat.conversations.list()
    setSummaries(list)
  }

  return (
    <div
      className={`conversation-item ${active ? 'active' : ''}`}
      onClick={handleClick}
      title={summary.title}
    >
      <div className="conversation-title">{summary.title}</div>
      <div className="conversation-preview">{summary.preview}</div>
      <button
        className="conversation-delete-btn"
        onClick={handleDelete}
        title="删除会话"
      >
        ✕
      </button>
    </div>
  )
}