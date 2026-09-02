import React, { useState, useEffect, useRef } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { ModelSelector } from './ModelSelector'
import { ProviderSelector } from './ProviderSelector'
import { ReasoningSelector } from './ReasoningSelector'
import { WebSearchToggle } from './WebSearchToggle'
import { CodexSearchModeSelector } from './CodexSearchModeSelector'
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
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const setStatus = useChatStreamStore((s) => s.setStatus)
  const setActiveAssistantMessage = useChatStreamStore((s) => s.setActiveAssistantMessage)
  const setError = useChatStreamStore((s) => s.setError)
  const error = useChatStreamStore((s) => s.error)
  const usage = useCodexUsageStore((s) => s.usage)
  const exhausted = isCodexExhausted(usage)
  // 使用自定义服务时，忽略 Codex 额度限制
  const isCustomProvider = !!activeConversation?.providerConfigId
  const isExhausted = exhausted && !isCustomProvider

  // 内存缓存当前会话的草稿，避免 IPC 往返延迟
  const draftRef = useRef<string>('')
  // 追踪上一次的 activeConversationId，用于切换时持久化旧草稿
  const prevConversationIdRef = useRef<string | null>(null)
  // 防抖写库 timer
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 切换会话时，先持久化旧草稿，再加载新草稿
  useEffect(() => {
    const prevId = prevConversationIdRef.current
    const newId = activeConversationId ?? null

    // 持久化旧会话的草稿（立即 flush，不防抖）
    if (prevId && prevId !== newId) {
      const oldDraft = draftRef.current
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      if (oldDraft) {
        window.openchat.settings.setDraft(prevId, oldDraft)
      }
    }

    prevConversationIdRef.current = newId

    if (!newId) {
      setText('')
      draftRef.current = ''
      return
    }

    // 加载新会话的草稿
    window.openchat.settings.getDraft(newId).then((saved) => {
      // 防止竞态：确保加载时还是这个会话
      if (useConversationStore.getState().activeConversationId === newId) {
        const draft = saved ?? ''
        setText(draft)
        draftRef.current = draft
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId])

  // 每次 text 变化时同步到 draftRef 并防抖持久化
  useEffect(() => {
    draftRef.current = text
    if (!activeConversationId) return

    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      window.openchat.settings.setDraft(activeConversationId, text)
    }, 500)
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [text, activeConversationId])

  // 错误提示自动消失
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(timer)
  }, [error, setError])

  const handleSend = async () => {
    console.log('[Composer] handleSend entry activeConversationId=%s text=%s streamingStatus=%s currentError=%s', activeConversation?.id ?? 'null', text.trim() ? `"${text.trim().slice(0, 30)}"` : '(empty)', useChatStreamStore.getState().status, useChatStreamStore.getState().error)
    if (!activeConversation || !text.trim()) { console.log('[Composer] handleSend SKIP: no conversation or empty text'); return }
    if (isExhausted) { console.log('[Composer] handleSend SKIP: exhausted'); return }

    // 清除上一个请求的残留错误
    setError(null)

    const conversationId = activeConversation.id
    const messageText = text.trim()
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    draftRef.current = ''
    setText('')
    window.openchat.settings.deleteDraft(conversationId)
    setStatus('starting')
    useChatStreamStore.getState().setStreamingConversationId(conversationId)

    try {
      const result = await window.openchat.chat.send(conversationId, messageText)
      console.log('[Composer] chat.send resolved, before setStatus=streaming, current status=%s streamingId=%s', useChatStreamStore.getState().status, useChatStreamStore.getState().streamingConversationId)
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
      console.log('[Composer] catch block: setting error, status=%s streamingId=%s', useChatStreamStore.getState().status, useChatStreamStore.getState().streamingConversationId)
      setError(message)
      // 仅当当前会话正是流式会话时才清理流式状态；否则说明是被主进程的
      // 单一生成槽位拦截（已有另一个会话在生成），此时不能清掉 streamingConversationId，
      // 否则另一个会话的 turn-completed/error 事件将失去过滤，错误地写入当前会话。
      const currentStreamingId = useChatStreamStore.getState().streamingConversationId
      if (currentStreamingId === conversationId) {
        setStatus('idle')
        setActiveAssistantMessage(null)
        useChatStreamStore.getState().setStreamingConversationId(null)
      }
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
          <CodexSearchModeSelector />
          <div className="composer-spacer" />
          <SendButton onSend={handleSend} onStop={handleStop} hasText={text.trim().length > 0 && !isExhausted} />
        </div>
      </div>
    </div>
  )
}