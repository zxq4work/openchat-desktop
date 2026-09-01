import React from 'react'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useConversationStore } from '../../stores/conversationStore'

interface Props {
  onSend: () => void
  onStop: () => void
  hasText: boolean
}

export function SendButton({ onSend, onStop, hasText }: Props) {
  const status = useChatStreamStore((s) => s.status)
  const streamingConversationId = useChatStreamStore((s) => s.streamingConversationId)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const isGenerating = (status === 'streaming' || status === 'starting') && streamingConversationId === activeConversationId

  if (isGenerating) {
    return (
      <button className="send-btn stop-btn" onClick={onStop} title="停止生成" aria-label="停止生成">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <rect x="2" y="2" width="10" height="10" rx="1.5" />
        </svg>
      </button>
    )
  }

  return (
    <button className="send-btn" onClick={onSend} disabled={!hasText} title="发送" aria-label="发送">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 13V3" />
        <path d="M3 8L8 3L13 8" />
      </svg>
    </button>
  )
}