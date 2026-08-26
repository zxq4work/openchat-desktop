import React, { useState, useEffect } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { ModelSelector } from './ModelSelector'
import { ProviderSelector } from './ProviderSelector'
import { ReasoningSelector } from './ReasoningSelector'
import { WebSearchToggle } from './WebSearchToggle'
import { MessageInput } from './MessageInput'
import { SendButton } from './SendButton'
import { useCodexUsageStore, isCodexExhausted } from '../../stores/codexUsageStore'

function formatResetTime(resetAt: number): string {
  const d = new Date(resetAt * 1000)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

export function Composer() {
  const [text, setText] = useState('')
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const setStatus = useChatStreamStore((s) => s.setStatus)
  const setActiveAssistantMessage = useChatStreamStore((s) => s.setActiveAssistantMessage)
  const setError = useChatStreamStore((s) => s.setError)
  const error = useChatStreamStore((s) => s.error)
  const usage = useCodexUsageStore((s) => s.usage)
  const exhausted = isCodexExhausted(usage)
  // 使用自定义服务时，忽略 Codex 额度限制
  const isCustomProvider = !!activeConversation?.providerConfigId
  const isExhausted = exhausted && !isCustomProvider

  // 错误提示自动消失
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(timer)
  }, [error, setError])

  const handleSend = async () => {
    if (!activeConversation || !text.trim()) return
    if (isExhausted) return

    const conversationId = activeConversation.id
    const messageText = text.trim()
    setText('')
    setStatus('starting')
    useChatStreamStore.getState().setStreamingConversationId(conversationId)

    try {
      const result = await window.openchat.chat.send(conversationId, messageText)
      setStatus('streaming')
      // 立即把 user/assistant 消息追加到 activeMessages，并设置 activeAssistantMessageId，
      // 保证旧会话（消息多、get 慢）下流式事件到达时组件已就绪，无需等 conversations.get 返回
      if (result) {
        useConversationStore.getState().setActiveMessages([
          ...useConversationStore.getState().activeMessages,
          result.userMessage,
          result.assistantMessage,
        ])
        setActiveAssistantMessage(result.assistantMessage.id)
      }

      // 只刷新侧边栏列表（会话标题可能已更新）
      // 注意：流式期间不再 conversations.get 全量刷新，避免旧会话大消息列表
      // 触发 activeMessages 整体替换导致文字抖动与增量内容重复
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
        {isExhausted && (
          <div className="composer-usage-exhausted">
            Codex 额度已用尽
            {usage.resetAt ? `，将于 ${formatResetTime(usage.resetAt)} 恢复。` : '。'}
          </div>
        )}
        {error && (
          <div className="composer-error">{error}</div>
        )}
        <MessageInput text={text} onChange={setText} onSend={handleSend} onStop={handleStop} />
        <div className="composer-controls">
          <ProviderSelector />
          <ModelSelector />
          <ReasoningSelector />
          <WebSearchToggle />
          <div className="composer-spacer" />
          <SendButton onSend={handleSend} onStop={handleStop} hasText={text.trim().length > 0 && !isExhausted} />
        </div>
      </div>
    </div>
  )
}