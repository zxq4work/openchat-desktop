import React, { useEffect, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useModelStore } from '../stores/modelStore'
import { useConversationStore } from '../stores/conversationStore'
import { useChatStreamStore } from '../stores/chatStreamStore'
import { useUiStore } from '../stores/uiStore'
import { Sidebar } from '../components/sidebar/Sidebar'
import { ChatView } from '../components/chat/ChatView'
import { ConversationRoleDialog } from '../components/settings/ConversationRoleDialog'
import { ConversationSettingsDialog } from '../components/settings/ConversationSettingsDialog'
import { SettingsDialog } from '../components/settings/SettingsDialog'
import { STREAM_FLUSH_MS } from '../../shared/constants'

export function App() {
  const setAuthStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)
  const setModels = useModelStore((s) => s.setModels)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const roleDialogOpen = useUiStore((s) => s.roleDialogOpen)
  const settingsDialogOpen = useUiStore((s) => s.settingsDialogOpen)
  const conversationSettingsOpen = useUiStore((s) => s.conversationSettingsOpen)

  // 初始化认证和模型
  useEffect(() => {
    async function init() {
      const account = await window.openchat.auth.getStatus()
      setAuthStatus(account.loggedIn ? 'logged-in' : 'logged-out')
      setAccount(account.email, account.planType, account.accountId)

      if (account.loggedIn) {
        const models = await window.openchat.models.refresh()
        setModels(models)
      }
    }
    init()

    const cleanupAuth = window.openchat.events.onAuthChanged((status: string) => {
      setAuthStatus(status as 'logged-in' | 'logged-out' | 'logging-in')
      if (status === 'logged-in') {
        // 只刷新一次：getStatus 会触发 checkAuth，但 checkAuth 已用 setStatusAndEmit 避免重复推送
        window.openchat.auth.getStatus().then((account) => {
          if (account.loggedIn) {
            setAccount(account.email, account.planType, account.accountId)
          }
        })
        window.openchat.models.refresh().then((models) => {
          setModels(models)
        })
      } else if (status === 'logged-out') {
        setAccount(null, null, null)
      }
    })

    return () => {
      cleanupAuth()
    }
  }, [setAuthStatus, setAccount, setModels])

  // 监听流式事件
  useEffect(() => {
    const pendingDeltas: string[] = []
    let accumulatedText = ''
    let flushTimer: ReturnType<typeof setInterval> | null = null
    let reasoningElapsedTimer: ReturnType<typeof setInterval> | null = null

    const startFlush = () => {
      if (flushTimer) return
      flushTimer = setInterval(() => {
        if (pendingDeltas.length > 0) {
          accumulatedText += pendingDeltas.join('')
          pendingDeltas.length = 0
          useChatStreamStore.getState().setBufferedText(accumulatedText)
        }
      }, STREAM_FLUSH_MS)
    }

    window.openchat.events.onChatDelta((event: unknown) => {
      const e = event as { text?: string }
      if (e.text) {
        pendingDeltas.push(e.text)
        startFlush()
      }
    })

    window.openchat.events.onChatReasoningStarted(() => {
      const now = Date.now()
      // 一次 turn 可能有多个 reasoning 阶段，从前一个阶段累加
      const prevMeta = useChatStreamStore.getState().reasoningMeta
      const baseSeconds = prevMeta ? Math.round(prevMeta.duration / 1000) : 0
      useChatStreamStore.getState().setReasoningStatus('thinking')
      useChatStreamStore.getState().setReasoningStartedAt(now)
      useChatStreamStore.getState().setReasoningElapsedSeconds(baseSeconds)
      // 每秒更新一次思考耗时
      if (reasoningElapsedTimer) clearInterval(reasoningElapsedTimer)
      reasoningElapsedTimer = setInterval(() => {
        const elapsed = baseSeconds + Math.round((Date.now() - now) / 1000)
        useChatStreamStore.getState().setReasoningElapsedSeconds(elapsed)
      }, 1000)
    })

    window.openchat.events.onChatReasoningCompleted((event: unknown) => {
      if (reasoningElapsedTimer) {
        clearInterval(reasoningElapsedTimer)
        reasoningElapsedTimer = null
      }
      const e = event as { reasoningMeta?: import('../../shared/types/conversation').ReasoningMeta }
      if (e.reasoningMeta) {
        useChatStreamStore.getState().setReasoningMeta(e.reasoningMeta)
      }
      useChatStreamStore.getState().setReasoningStatus('completed')
    })

    window.openchat.events.onChatError((event: unknown) => {
      const e = event as { errorCode?: string; errorMessage?: string }
      console.error('[App] Chat error:', e.errorCode, e.errorMessage)
      if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      if (reasoningElapsedTimer) {
        clearInterval(reasoningElapsedTimer)
        reasoningElapsedTimer = null
      }
      accumulatedText = ''
      pendingDeltas.length = 0
      useChatStreamStore.getState().reset()

      const id = useConversationStore.getState().activeConversationId
      if (id) {
        window.openchat.conversations.get(id).then((data) => {
          if (data) {
            useConversationStore.getState().setActiveConversation(data.conversation)
            useConversationStore.getState().setActiveMessages(data.messages)
            useConversationStore.getState().setActiveSegments(data.segments)
          }
        })
      }
    })

    window.openchat.events.onTurnCompleted(() => {
      if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      if (reasoningElapsedTimer) {
        clearInterval(reasoningElapsedTimer)
        reasoningElapsedTimer = null
      }
      // 最后 flush 一次
      if (pendingDeltas.length > 0) {
        accumulatedText += pendingDeltas.join('')
        pendingDeltas.length = 0
        useChatStreamStore.getState().setBufferedText(accumulatedText)
      }
      // 重置闭包中的累积变量，防止下一轮流式中出现旧内容残留
      accumulatedText = ''
      pendingDeltas.length = 0
      useChatStreamStore.getState().reset()

      // 重新加载消息以获取最终的 status/content
      const id = useConversationStore.getState().activeConversationId
      if (id) {
        window.openchat.conversations.get(id).then((data) => {
          if (data) {
            useConversationStore.getState().setActiveConversation(data.conversation)
            useConversationStore.getState().setActiveMessages(data.messages)
            useConversationStore.getState().setActiveSegments(data.segments)
          }
        })
      }

      // 刷新侧边栏列表（标题/preview 已更新）
      window.openchat.conversations.list().then((list) => {
        useConversationStore.getState().setSummaries(list)
      })
    })

    return () => {
      if (flushTimer) clearInterval(flushTimer)
      if (reasoningElapsedTimer) clearInterval(reasoningElapsedTimer)
    }
  }, [])

  // 快捷键监听
  useEffect(() => {
    const cleanupNewTopic = window.openchat.events.onNewTopic(async () => {
      const id = useConversationStore.getState().activeConversationId
      if (id) {
        await window.openchat.conversations.newTopic(id)
        // 刷新 UI：重新加载会话数据，显示 ContextBoundary
        const data = await window.openchat.conversations.get(id)
        if (data) {
          useConversationStore.getState().setActiveConversation(data.conversation)
          useConversationStore.getState().setActiveMessages(data.messages)
          useConversationStore.getState().setActiveSegments(data.segments)
        }
      }
    })

    const cleanupNewConv = window.openchat.events.onNewConversation(() => {
      handleNewConversation()
    })

    return () => {
      cleanupNewTopic()
      cleanupNewConv()
    }
  }, [])

  const handleNewConversation = useCallback(async () => {
    const models = useModelStore.getState().models
    const defaultModel = models.length > 0 ? models[0].id : null
    const defaultEffort = models.length > 0 && models[0].defaultReasoningEffort
      ? models[0].defaultReasoningEffort
      : models.length > 0 && models[0].supportedReasoningEfforts.length > 0
        ? models[0].supportedReasoningEfforts[0].reasoningEffort
        : null

    const conv = await window.openchat.conversations.create(defaultModel, defaultEffort)
    if (conv) {
      const summaries = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(summaries)
      useConversationStore.getState().setActiveConversationId(conv.id)
      useConversationStore.getState().setActiveConversation(conv)
      useConversationStore.getState().setActiveMessages([])
      useConversationStore.getState().setActiveSegments([])
    }
  }, [])

  return (
    <div className="app-container">
      <Sidebar />
      <ChatView />
      {roleDialogOpen && activeConversationId && <ConversationRoleDialog />}
      {conversationSettingsOpen && activeConversationId && <ConversationSettingsDialog />}
      {settingsDialogOpen && <SettingsDialog />}
    </div>
  )
}