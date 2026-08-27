import React, { useRef, useEffect } from 'react'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'

interface Props {
  text: string
  onChange: (text: string) => void
  onSend: () => void
  onStop: () => void
}

export function MessageInput({ text, onChange, onSend, onStop }: Props) {
  const status = useChatStreamStore((s) => s.status)
  const streamingConversationId = useChatStreamStore((s) => s.streamingConversationId)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const isCurrentConversationStreaming = (status === 'streaming' || status === 'starting') && streamingConversationId === activeConversationId
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const focusRequestId = useUiStore((s) => s.focusRequestId)

  // 会话切换、新建或复用空白会话时聚焦输入框
  useEffect(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [activeConversationId, focusRequestId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合输入中不处理（如中文输入法按回车确认英文）
    if (e.nativeEvent.isComposing) return

    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isCurrentConversationStreaming) {
        // 当前会话正在流式生成，忽略回车，不停止也不发送
        return
      } else if (text.trim()) {
        onSend()
      }
    }
    // Esc 停止生成
    if (e.key === 'Escape') {
      if (isCurrentConversationStreaming) {
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