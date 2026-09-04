import React, { useEffect, useCallback } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useModelStore } from '../stores/modelStore'
import { useConversationStore } from '../stores/conversationStore'
import { useChatStreamStore } from '../stores/chatStreamStore'
import { useUiStore } from '../stores/uiStore'
import { useThemeStore } from '../stores/themeStore'
import { useCodexUsageStore } from '../stores/codexUsageStore'
import { useProviderStore, type SafeProviderConfig } from '../stores/providerStore'
import { Sidebar } from '../components/sidebar/Sidebar'
import { ChatView } from '../components/chat/ChatView'
import { ConversationSettingsDialog } from '../components/settings/ConversationSettingsDialog'
import { SettingsDialog } from '../components/settings/SettingsDialog'
import { presentSearchResults } from '../packages/SearchResultPresenter'
import { hostnameFromUrl } from '../../shared/utils/searchDisplay'
import type { WebSearchResultItem } from '../../shared/types/conversation'
import { STREAM_FLUSH_MS } from '../../shared/constants'

export function App() {
  const setAuthStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)
  const setModels = useModelStore((s) => s.setModels)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const settingsDialogOpen = useUiStore((s) => s.settingsDialogOpen)
  const conversationSettingsOpen = useUiStore((s) => s.conversationSettingsOpen)
  const toast = useUiStore((s) => s.toast)
  const clearToast = useUiStore((s) => s.clearToast)

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => clearToast(), 2500)
      return () => clearTimeout(timer)
    }
  }, [toast, clearToast])

  // 首帧渲染完成后通知主进程关闭 Splash 并显示主窗口。
  // 使用双 rAF 确保至少一帧已绘制，避免主窗口 show 时出现白屏。
  useEffect(() => {
    let cancelled = false
    const raf2 = () => {
      if (!cancelled) window.openchat.app.notifyReady()
    }
    const raf1 = () => {
      if (!cancelled) requestAnimationFrame(raf2)
    }
    const id = requestAnimationFrame(raf1)
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [])

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

    // 初始化 Provider 列表
    window.openchat.providers.list().then((list) => {
      useProviderStore.getState().setProviders(list as SafeProviderConfig[])
    })

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
    let reasoningTextAccum = ''
    // 收集所有 IPC 监听器的清理函数，避免 StrictMode 双挂载导致重复监听
    const disposers: Array<() => void> = []

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

    disposers.push(window.openchat.events.onChatDelta((event: unknown) => {
      const e = event as { text?: string; conversationId?: string }
      console.log('[App RAW] delta conversationId=%s textLen=%d', e.conversationId ?? '?', e.text?.length ?? 0)
      if (e.text) {
        const streamingId = useChatStreamStore.getState().streamingConversationId
        if (!streamingId) {
          // 懒绑定：仅当事件所属会话与当前激活会话一致时才采纳
          const activeConvId = useConversationStore.getState().activeConversationId
          if (e.conversationId && e.conversationId !== activeConvId) return
          useChatStreamStore.getState().setStreamingConversationId(e.conversationId ?? null)
        } else if (e.conversationId && e.conversationId !== streamingId) {
          return
        }
        pendingDeltas.push(e.text)
        startFlush()
      }
    }))

    disposers.push(window.openchat.events.onChatReasoningStarted((event: unknown) => {
      const e = event as { conversationId?: string }
      console.log('[App RAW] reasoning-started conversationId=%s', e.conversationId ?? '?')
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (!streamingId) {
        // 懒绑定：仅当事件所属会话与当前激活会话一致时才采纳
        const activeConvId = useConversationStore.getState().activeConversationId
        if (e.conversationId && e.conversationId !== activeConvId) return
        useChatStreamStore.getState().setStreamingConversationId(e.conversationId ?? null)
      }
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      // 多阶段推理：追加分隔符，不清空已有文本
      if (reasoningTextAccum) {
        reasoningTextAccum += '\n\n'
      }

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
    }))

    disposers.push(window.openchat.events.onChatReasoningDelta((event: unknown) => {
      const e = event as { text?: string; conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (!streamingId) {
        // 懒绑定：仅当事件所属会话与当前激活会话一致时才采纳
        const activeConvId = useConversationStore.getState().activeConversationId
        if (e.conversationId && e.conversationId !== activeConvId) return
        useChatStreamStore.getState().setStreamingConversationId(e.conversationId ?? null)
      } else if (e.conversationId && e.conversationId !== streamingId) return
      if (e.text) {
        reasoningTextAccum += e.text
        useChatStreamStore.getState().setReasoningText(reasoningTextAccum)
      }
    }))

    disposers.push(window.openchat.events.onChatReasoningCompleted((event: unknown) => {
      const e = event as { reasoningMeta?: import('../../shared/types/conversation').ReasoningMeta; conversationId?: string }
      console.log('[App RAW] reasoning-completed conversationId=%s', e.conversationId ?? '?')
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
    }))

    disposers.push(window.openchat.events.onWebSearchStarted((event: unknown) => {
      const e = event as { conversationId?: string; toolCallId?: string; toolCallName?: string; toolCallArgs?: string }
      console.log('[App RAW] web-search-started conversationId=%s toolCallId=%s toolName=%s', e.conversationId ?? '?', e.toolCallId ?? '?', e.toolCallName ?? '?')
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      let query: string | null = null
      if (e.toolCallArgs) {
        try {
          const args = JSON.parse(e.toolCallArgs) as Record<string, unknown>
          if (typeof args.query === 'string') {
            query = args.query
          } else if (typeof args.url === 'string') {
            query = args.url
          }
        } catch {
          query = null
        }
      }
      useChatStreamStore.getState().setWebSearchStatus({
        active: true,
        callId: e.toolCallId ?? null,
        toolName: e.toolCallName ?? null,
        query,
      })
    }))

    disposers.push(window.openchat.events.onWebSearchCompleted((event: unknown) => {
      const e = event as { conversationId?: string; toolCallId?: string; webSearchResults?: unknown[] }
      console.log('[App RAW] web-search-completed conversationId=%s toolCallId=%s resultsCount=%d', e.conversationId ?? '?', e.toolCallId ?? '?', e.webSearchResults?.length ?? 0)
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      const results: WebSearchResultItem[] = e.webSearchResults
        ? presentSearchResults(e.webSearchResults).map((card) => {
            const rawUrl = card.url ?? card.link ?? card.uri ?? null
            const rawTitle = card.title ?? card.name ?? null
            const sourceType = (card.raw as Record<string, unknown>)?.sourceType === 'api' ? 'api' as const : 'web' as const
            return {
              title: rawTitle ?? hostnameFromUrl(rawUrl),
              url: rawUrl,
              snippet: card.snippet ?? card.description ?? card.text ?? null,
              sourceType,
            }
          })
        : []

      const prev = useChatStreamStore.getState().webSearchStatus
      const merged = [...prev.results, ...results]
      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        query: null,
        results: merged,
      })
    }))

    disposers.push(window.openchat.events.onWebSearchError((event: unknown) => {
      const e = event as { conversationId?: string; toolCallError?: string }
      console.log('[App RAW] web-search-error conversationId=%s error=%s', e.conversationId ?? '?', e.toolCallError ?? '?')
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        error: e.toolCallError ?? '搜索失败',
      })
    }))

    // Codex Native Search 事件：server-side web_search_call 状态
    disposers.push(window.openchat.events.onWebSearchCallStarted((event: unknown) => {
      const e = event as { conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return
      useChatStreamStore.getState().setWebSearchStatus({
        active: true,
        callId: null,
        toolName: 'web_search',
        query: null,
        error: null,
      })
    }))

    disposers.push(window.openchat.events.onWebSearchCallCompleted((event: unknown) => {
      const e = event as { conversationId?: string; webSearchResults?: unknown[] }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      const results: WebSearchResultItem[] = e.webSearchResults
        ? presentSearchResults(e.webSearchResults).map((card) => {
            const rawUrl = card.url ?? card.link ?? card.uri ?? null
            const rawTitle = card.title ?? card.name ?? null
            const sourceType = (card.raw as Record<string, unknown>)?.sourceType === 'api' ? 'api' as const : 'web' as const
            return {
              title: rawTitle ?? hostnameFromUrl(rawUrl),
              url: rawUrl,
              snippet: card.snippet ?? card.description ?? card.text ?? null,
              sourceType,
            }
          })
        : []

      const prev2 = useChatStreamStore.getState().webSearchStatus
      const merged2 = [...prev2.results, ...results]
      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        query: null,
        results: merged2,
      })
    }))

    disposers.push(window.openchat.events.onWebSearchCallFailed((event: unknown) => {
      const e = event as { conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return
      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        error: 'Codex 搜索失败',
      })
    }))

    disposers.push(window.openchat.events.onStreamReset((event: unknown) => {
      const e = event as { conversationId?: string }
      console.log('[App RAW] stream-reset conversationId=%s', e.conversationId ?? '?')
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      // 清除 ToolLoop 错误文本与已积累的搜索结果，准备 PreSearch 重新流式
      accumulatedText = ''
      pendingDeltas.length = 0
      useChatStreamStore.getState().setBufferedText('')
      useChatStreamStore.getState().setWebSearchStatus({
        active: false,
        callId: null,
        query: null,
        results: [],
      })
    }))

    disposers.push(window.openchat.events.onChatError((event: unknown) => {
      const e = event as { errorCode?: string; errorMessage?: string; conversationId?: string }
      const streamingId = useChatStreamStore.getState().streamingConversationId
      console.log('[App RAW] chat-error conversationId=%s errorCode=%s streamingId=%s status=%s', e.conversationId ?? '?', e.errorCode ?? '?', streamingId ?? 'null', useChatStreamStore.getState().status)
      if (e.conversationId && streamingId && e.conversationId !== streamingId) { console.log('[App RAW] chat-error SKIP: conversation mismatch'); return }

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
      reasoningTextAccum = ''

      // 仅当事件所属会话正是当前激活会话时才更新 activeMessages
      const activeConvId = useConversationStore.getState().activeConversationId
      const eventConvId = e.conversationId
      if (eventConvId && eventConvId !== activeConvId) {
        console.log('[App chat-error] SKIP message update: event conv %s != active conv %s', eventConvId, activeConvId)
      } else {
        // 标记最后一条 assistant 消息为失败，不重新加载消息列表（避免竞态抖动）
        const messages = useConversationStore.getState().activeMessages
        const lastAssistantIdx = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') return i
          }
          return -1
        })()
        if (lastAssistantIdx >= 0) {
          const updated = [...messages]
          updated[lastAssistantIdx] = {
            ...updated[lastAssistantIdx],
            status: 'failed',
            errorCode: e.errorCode ?? 'StreamFailed',
            errorMessage: e.errorMessage ?? 'Unknown error',
          }
          useConversationStore.getState().setActiveMessages(updated)
        }
      }

      // 只清除流式状态，不 reset（保留 webSearchStatus 等）
      useChatStreamStore.getState().setStatus('idle')
      useChatStreamStore.getState().setStreamingConversationId(null)
      useChatStreamStore.getState().setActiveAssistantMessage(null)
      useChatStreamStore.getState().setBufferedText('')
      useChatStreamStore.getState().setReasoningStatus('idle')
      useChatStreamStore.getState().setReasoningText('')
    }))

    disposers.push(window.openchat.events.onTurnCompleted((event: unknown) => {
      const e = event as { conversationId?: string }
      console.log('[App RAW] turn-completed conversationId=%s', e.conversationId ?? '?')
      const streamingId = useChatStreamStore.getState().streamingConversationId
      if (e.conversationId && streamingId && e.conversationId !== streamingId) return

      console.log('[App turn-completed] messagesCount=%d accumulatedTextLen=%d pendingDeltasCount=%d',
        useConversationStore.getState().activeMessages.length,
        accumulatedText.length,
        pendingDeltas.length)

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

      // 仅当事件所属会话正是当前激活会话时才更新 activeMessages，
      // 防止用户在流式期间切换到其他会话后，已完成事件错误地写入当前会话
      const activeConvId = useConversationStore.getState().activeConversationId
      const eventConvId = e.conversationId
      if (eventConvId && eventConvId !== activeConvId) {
        console.log('[App turn-completed] SKIP: event conv %s != active conv %s', eventConvId, activeConvId)
      } else {
        // 直接标记最后一条 assistant 消息为 completed，不重新从 DB 加载
        // 避免与 Composer 追加消息的竞态导致消息消失
        const messages = useConversationStore.getState().activeMessages
        const lastAssistantIdx = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') return i
          }
          return -1
        })()
        console.log('[App turn-completed] lastAssistantIdx=%d lastMsgId=%s lastMsgStatus=%s',
          lastAssistantIdx,
          lastAssistantIdx >= 0 ? messages[lastAssistantIdx].id : 'N/A',
          lastAssistantIdx >= 0 ? messages[lastAssistantIdx].status : 'N/A')
        if (lastAssistantIdx >= 0) {
          const streamState = useChatStreamStore.getState()
          const updated = [...messages]
          updated[lastAssistantIdx] = {
            ...updated[lastAssistantIdx],
            content: accumulatedText || updated[lastAssistantIdx].content,
            reasoningMeta: streamState.reasoningMeta ?? updated[lastAssistantIdx].reasoningMeta,
            webSearchResults: streamState.webSearchStatus.results.length > 0
              ? streamState.webSearchStatus.results
              : updated[lastAssistantIdx].webSearchResults,
            webSearchError: streamState.webSearchStatus.error ?? updated[lastAssistantIdx].webSearchError,
            status: 'completed',
          }
          console.log('[App turn-completed] updated contentLen=%d', updated[lastAssistantIdx].content.length)
          useConversationStore.getState().setActiveMessages(updated)
        }
      }

      accumulatedText = ''
      pendingDeltas.length = 0
      reasoningTextAccum = ''
      useChatStreamStore.getState().reset()

      // 刷新侧边栏列表（标题/preview 已更新）
      window.openchat.conversations.list().then((list) => {
        useConversationStore.getState().setSummaries(list)
      })
    }))

    return () => {
      if (flushTimer) clearInterval(flushTimer)
      if (reasoningElapsedTimer) clearInterval(reasoningElapsedTimer)
      // 清理所有 IPC 监听器，避免 StrictMode 双挂载导致重复回调
      for (const dispose of disposers) {
        dispose()
      }
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
  // 拦截 Ctrl/Cmd+F：在聊天区域打开搜索栏，输入框内跳过
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey

      const isSelectAll = isMod && (e.key === 'a' || e.key === 'A')
      const isFind = isMod && (e.key === 'f' || e.key === 'F')

      if (!isSelectAll && !isFind) return

      const target = e.target as HTMLElement | null
      const editable =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (isSelectAll && !editable) {
        e.preventDefault()
      }

      if (isFind) {
        // 焦点已在搜索输入框内：全选内容，阻止浏览器默认行为
        if (target?.classList.contains('search-bar-input')) {
          e.preventDefault();
          (target as HTMLInputElement).select()
          return
        }

        if (editable) return

        // 聊天区里的消息列表不是可聚焦元素，点击后焦点仍在 body 上，
        // 因此这里结合 activeElement 与是否存在活跃对话来判断是否在聊天界面
        const active = document.activeElement
        const hasActiveConversation = !!useConversationStore.getState().activeConversationId
        const inChatView =
          active && active !== document.body && active !== document.documentElement
            ? !!active.closest('.chat-view')
            : hasActiveConversation

        if (inChatView) {
          e.preventDefault()
          const state = useUiStore.getState()
          if (state.searchVisible) {
            // 搜索框已存在时：聚焦并选中已有内容
            const input = document.querySelector<HTMLInputElement>('.search-bar-input')
            input?.focus()
            input?.select()
          } else {
            state.openSearch()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleNewConversation = useCallback(async () => {
    // 若当前活跃会话是空白的（无消息），直接复用，不新建
    const store = useConversationStore.getState()
    if (store.activeConversationId && store.activeMessages.length === 0) {
      useUiStore.getState().requestComposerFocus()
      return
    }

    const saved = await window.openchat.settings.getDefaultModel()
    const defaultWebSearch = await window.openchat.settings.getDefaultWebSearch()
    const defaultSearchEngine = await window.openchat.settings.getWebSearchEngine()
    const models = useModelStore.getState().models

    let defaultModel = saved.modelId
    let defaultEffort = saved.effort

    if (!defaultModel && models.length > 0) {
      defaultModel = models[0].id
    }
    if (!defaultEffort && models.length > 0) {
      defaultEffort = models[0].defaultReasoningEffort
        ?? (models[0].supportedReasoningEfforts.length > 0
          ? models[0].supportedReasoningEfforts[0].reasoningEffort
          : null)
    }

    const conv = await window.openchat.conversations.create(defaultModel, defaultEffort, undefined, saved.providerId, defaultWebSearch, defaultSearchEngine)
    if (conv) {
      const list = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(list)
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}