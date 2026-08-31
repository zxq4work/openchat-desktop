import React from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { ConversationItem } from './ConversationItem'

export function ConversationList() {
  const summaries = useConversationStore((s) => s.summaries)
  const activeId = useConversationStore((s) => s.activeConversationId)

  return (
    <div className="conversation-list">
      {summaries.length === 0 ? (
        <div className="conversation-empty">暂无对话</div>
      ) : (
        summaries.map((summary) => (
          <ConversationItem
            key={summary.id}
            summary={summary}
            active={summary.id === activeId}
          />
        ))
      )}
    </div>
  )
}