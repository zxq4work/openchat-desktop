import React from 'react'
import { useChatStreamStore } from '../../stores/chatStreamStore'

interface Props {
  onSend: () => void
  onStop: () => void
  hasText: boolean
}

export function SendButton({ onSend, onStop, hasText }: Props) {
  const status = useChatStreamStore((s) => s.status)
  const isGenerating = status === 'streaming' || status === 'starting'

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