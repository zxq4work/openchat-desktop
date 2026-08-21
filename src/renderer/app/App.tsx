import React, { useEffect, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useModelStore } from '../stores/modelStore'
import { useConversationStore } from '../stores/conversationStore'
import { useChatStreamStore } from '../stores/chatStreamStore'
import { useUiStore } from '../stores/uiStore'
import { useThemeStore } from '../stores/themeStore'
import { useCodexUsageStore } from '../stores/codexUsageStore'
import { Sidebar } from '../components/sidebar/Sidebar'
import { ChatView } from '../components/chat/ChatView'
import { ConversationSettingsDialog } from '../components/settings/ConversationSettingsDialog'
import { SettingsDialog } from '../components/settings/SettingsDialog'
import { presentSearchResults } from '../packages/SearchResultPresenter'
import type { WebSearchResultItem } from '../../shared/types/conversation'
import { STREAM_FLUSH_MS } from '../../shared/constants'

export function App() {
  const setAuthStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)
  const setModels = useModelStore((s) => s.setModels)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const settingsDialogOpen = useUiStore((s) => s.settingsDialogOpen)
  const conversationSettingsOpen = useUiStore((s) => s.conversationSettingsOpen)

  // 初始化认证和模型
  useEffect(() => {
    async function init() {
      const account = await window.openchat.auth.getStatus()
      setAuthStatus(account.loggedIn ? 'logged-in' : 'logged-out')
      setAccount(account.email, account.planType, account.userId, account.accountId)

      if (account.loggedIn) {
        const models = await window.openchat.models.refresh()
        setModels(models)
      }
    }
    init()

    // 初始化 Codex Usage 状态
    window.openchat.codexUsage.get().then((view) => {
      useCodexUsageStore.getState().setUsage(view)
    })

    const cleanupUsage = window.openchat.codexUsage.onChanged((view) => {
      useCodexUsageStore.getState().setUsage(view)
    })

    const cleanupAuth = window.openchat.events.onAuthChanged((status: string) => {
      setAuthStatus(status as 'logged-in' | 'logged-out' | 'logging-in')
      if (status === 'logged-in') {
        // 只刷新一次：getStatus 会触发 checkAuth，但 checkAuth 已用 setStatusAndEmit 避免重复推送
        window.openchat.auth.getStatus().then((account) => {
          if (account.loggedIn) {
            setAccount(account.email, account.planType, account.userId, account.accountId)
          }
        })
        window.openchat.models.refresh().then((models) => {
          setModels(models)
        })
      } else if (status === 'logged-out') {
        setAccount(null, null, null, null)
      }
    })

    return () => {
      cleanupAuth()
      cleanupUsage()
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
      const e = event as { text?: string; conversationId?: string }
      if (e.text) {
        const streamingId = useChatStreamStore.getState().streamingConversationId
        if (!streamingId) {
          useChatStreamStore.getState().setStreamingConversationId(e.conversationId ?? null)
        } else if (e.conversationId && e.conversationId !== streamingId) {
          return
        }
        pendingDeltas.push(e.text)
        startFlush()
      }
    })

    window.openchat.events.onChatReasoningStarted((event: unknown) => {
      const e = event as { conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (!streamingId) {
        useChatStreamStore.getState().setStreamingConversationId(e.conversationId ?? null)
      }
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

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
      const e = event as { reasoningMeta?: import('../../shared/types/conversation').ReasoningMeta; conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      if (reasoningElapsedTimer) {
        clearInterval(reasoningElapsedTimer)
        reasoningElapsedTimer = null
      }
      if (e.reasoningMeta) {
        useChatStreamStore.getState().setReasoningMeta(e.reasoningMeta)
      }
      useChatStreamStore.getState().setReasoningStatus('completed')
    })

    window.openchat.events.onWebSearchStarted((event: unknown) => {
      const e = event as { conversationId?: string; toolCallId?: string; toolCallArgs?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      let query: string | null = null
      if (e.toolCallArgs) {
        try {
          const args = JSON.parse(e.toolCallArgs) as Record<string, unknown>
          if (Array.isArray(args.search_query) && args.search_query.length > 0) {
            const first = args.search_query[0] as Record<string, unknown>
            if (typeof first.q === 'string') query = first.q
          }
        } catch {
          query = null
        }
      }
      useChatStreamStore.getState().setWebSearchStatus({ active: true, callId: e.toolCallId ?? null, query, error: null })
    })

    window.openchat.events.onWebSearchCompleted((event: unknown) => {
      const e = event as { conversationId?: string; toolCallId?: string; webSearchResults?: unknown[] }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      const results: WebSearchResultItem[] = e.webSearchResults
        ? presentSearchResults(e.webSearchResults).map((card) => ({
            title: card.title ?? card.name ?? null,
            url: card.url ?? card.link ?? null,
            snippet: card.snippet ?? card.description ?? card.text ?? null,
          }))
        : []

      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        query: null,
        error: null,
        results,
      })
    })

    window.openchat.events.onWebSearchError((event: unknown) => {
      const e = event as { conversationId?: string; toolCallError?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        error: e.toolCallError ?? '搜索失败',
      })
    })

    window.openchat.events.onChatError((event: unknown) => {
      const e = event as { errorCode?: string; errorMessage?: string; conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

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

    window.openchat.events.onTurnCompleted((event: unknown) => {
      const e = event as { conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

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
      // 先重新加载消息以获取最终的 status/content，再重置流式状态
      // 避免 reset() 清空 bufferedText 后消息内容短暂缺失导致高度抖动
      const id = useConversationStore.getState().activeConversationId
      if (id) {
        window.openchat.conversations.get(id).then((data) => {
          if (data) {
            useConversationStore.getState().setActiveConversation(data.conversation)
            useConversationStore.getState().setActiveMessages(data.messages)
            useConversationStore.getState().setActiveSegments(data.segments)
          }
          accumulatedText = ''
          pendingDeltas.length = 0
          useChatStreamStore.getState().reset()
        })
      } else {
        accumulatedText = ''
        pendingDeltas.length = 0
        useChatStreamStore.getState().reset()
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

  // 主题初始化与系统主题变化监听
  useEffect(() => {
    const resolved = useThemeStore.getState().resolved
    document.documentElement.setAttribute('data-theme', resolved)

    const unsubResolved = useThemeStore.subscribe((state) => {
      document.documentElement.setAttribute('data-theme', state.resolved)
    })

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemChange = () => {
      useThemeStore.getState().applySystemTheme()
    }
    mediaQuery.addEventListener('change', handleSystemChange)

    return () => {
      unsubResolved()
      mediaQuery.removeEventListener('change', handleSystemChange)
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

  // 拦截 Ctrl/Cmd+A：仅在焦点位于可编辑输入框时允许全选，
  // 避免原生应用里出现「整页文字被选中」的 HTML 页感
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isSelectAll = (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')
      if (!isSelectAll) return

      const target = e.target as HTMLElement | null
      const editable =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (!editable) {
        e.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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
      {conversationSettingsOpen && activeConversationId && <ConversationSettingsDialog />}
      {settingsDialogOpen && <SettingsDialog />}
    </div>
  )
}