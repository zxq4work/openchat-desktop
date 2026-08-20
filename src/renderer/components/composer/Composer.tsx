import React, { useState, useEffect } from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { ModelSelector } from './ModelSelector'
import { ReasoningSelector } from './ReasoningSelector'
import { RoleSettingsButton } from './RoleSettingsButton'
import { MessageInput } from './MessageInput'
import { SendButton } from './SendButton'

export function Composer() {
  const [text, setText] = useState('')
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const setStatus = useChatStreamStore((s) => s.setStatus)
  const setActiveAssistantMessage = useChatStreamStore((s) => s.setActiveAssistantMessage)
  const setError = useChatStreamStore((s) => s.setError)
  const error = useChatStreamStore((s) => s.error)

  // 错误提示自动消失
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(timer)
  }, [error, setError])

  const handleSend = async () => {
    if (!activeConversation || !text.trim()) return

    const conversationId = activeConversation.id
    const messageText = text.trim()
    setText('')
    setStatus('starting')
    useChatStreamStore.getState().setStreamingConversationId(conversationId)

    try {
      await window.openchat.chat.send(conversationId, messageText)
      setStatus('streaming')

      // 刷新会话数据
      const data = await window.openchat.conversations.get(conversationId)
      if (data) {
        useConversationStore.getState().setActiveConversation(data.conversation)
        useConversationStore.getState().setActiveMessages(data.messages)
        useConversationStore.getState().setActiveSegments(data.segments)

        // 找到正在流式生成的 assistant 消息，设为 active 以便渲染增量文本
        const streamingMsg = data.messages.find(
          (m: Message) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'pending')
        )
        if (streamingMsg) {
          setActiveAssistantMessage(streamingMsg.id)
        }
      }

      // 刷新侧边栏列表（会话标题可能已更新）
      const list = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(list)
    } catch (err) {
      console.error('[Composer] Send failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('idle')
      setActiveAssistantMessage(null)
    }
  }

  const handleStop = async () => {
    setStatus('stopping')
    setActiveAssistantMessage(null)
    useChatStreamStore.getState().setStreamingConversationId(null)
    await window.openchat.chat.interrupt()

    // 刷新消息列表以获取更新后的状态（stopped）
    const conversationId = activeConversation?.id
    if (conversationId) {
      const data = await window.openchat.conversations.get(conversationId)
      if (data) {
        useConversationStore.getState().setActiveConversation(data.conversation)
        useConversationStore.getState().setActiveMessages(data.messages)
        useConversationStore.getState().setActiveSegments(data.segments)
      }
      // 刷新侧边栏列表
      const list = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(list)
    }

    setStatus('idle')
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        {error && (
          <div className="composer-error">{error}</div>
        )}
        <MessageInput text={text} onChange={setText} onSend={handleSend} onStop={handleStop} />
        <div className="composer-controls">
          <ModelSelector />
          <ReasoningSelector />
          <RoleSettingsButton />
          <div className="composer-spacer" />
          <SendButton onSend={handleSend} onStop={handleStop} hasText={text.trim().length > 0} />
        </div>
      </div>
    </div>
  )
}