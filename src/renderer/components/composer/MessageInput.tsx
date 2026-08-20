import React, { useRef } from 'react'
import { useChatStreamStore } from '../../stores/chatStreamStore'

interface Props {
  text: string
  onChange: (text: string) => void
  onSend: () => void
  onStop: () => void
}

export function MessageInput({ text, onChange, onSend, onStop }: Props) {
  const status = useChatStreamStore((s) => s.status)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合输入中不处理（如中文输入法按回车确认英文）
    if (e.nativeEvent.isComposing) return

    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (status === 'streaming' || status === 'starting') {
        onStop()
      } else if (text.trim()) {
        onSend()
      }
    }
    // Esc 停止生成
    if (e.key === 'Escape') {
      if (status === 'streaming' || status === 'starting') {
        onStop()
      }
    }
  }

  return (
    <div className="message-input-wrapper">
      <textarea
        ref={textareaRef}
        className="message-input"
        placeholder="输入消息……"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
      />
    </div>
  )
}