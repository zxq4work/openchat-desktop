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
      <button className="send-btn stop-btn" onClick={onStop} title="停止生成">
        ■
      </button>
    )
  }

  return (
    <button className="send-btn" onClick={onSend} disabled={!hasText} title="发送">
      ↑
    </button>
  )
}