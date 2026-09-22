import React, { useEffect, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownRenderer } from '../components/MarkdownRenderer'
import { useAuthStore } from '../stores/authStore'
import { useModelStore } from '../stores/modelStore'
import { useConversationStore } from '../stores/conversationStore'
import { useChatStreamStore } from '../stores/chatStreamStore'
import { useImageGenerationStore } from '../stores/imageGenerationStore'
import { useUiStore } from '../stores/uiStore'
import { useThemeStore } from '../stores/themeStore'
import { useCodexUsageStore } from '../stores/codexUsageStore'
import { useProviderStore, type SafeProviderConfig } from '../stores/providerStore'
import { Sidebar } from '../components/sidebar/Sidebar'
import { ChatView } from '../components/chat/ChatView'
import { InitErrorScreen } from '../components/InitErrorScreen'
import { ConversationSettingsDialog } from '../components/settings/ConversationSettingsDialog'
import { SettingsDialog } from '../components/settings/SettingsDialog'
import { presentSearchResults } from '../packages/SearchResultPresenter'
import { hostnameFromUrl } from '../../shared/utils/searchDisplay'
import type { WebSearchResultItem } from '../../shared/types/conversation'
import { STREAM_FLUSH_MS, RENDERER_BOOT_STATE_POLL_MS } from '../../shared/constants'
import { finishBootSplash } from './boot-splash'
import { rlog } from './boot-log'
import { hastCacheStats, hastCacheResetStats, hastCacheClear } from '../packages/markdownHastCache'

export function App() {
  const setAuthStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)
  const setModels = useModelStore((s) => s.setModels)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const settingsDialogOpen = useUiStore((s) => s.settingsDialogOpen)
  const conversationSettingsOpen = useUiStore((s) => s.conversationSettingsOpen)
  const toast = useUiStore((s) => s.toast)
  const clearToast = useUiStore((s) => s.clearToast)
  const initError = useUiStore((s) => s.initError)
  const setInitError = useUiStore((s) => s.setInitError)

  // 一次性挂载副作用去重：StrictMode 下 effect 会 mount→unmount→mount 执行两次，
  // 导致 init()（models.refresh）、providers.list、codexUsage.get 等一次性拉取重复触发。
  // 用 ref 标记「已发起过」，避免 dev 下重复请求；生产（StrictMode 不双调用）不受影响。
  const bootInitStartedRef = useRef(false)

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => clearToast(), 2500)
      return () => clearTimeout(timer)
    }
  }, [toast, clearToast])

  // Markdown/KaTeX 预热：应用生命周期仅执行一次，挂载代表性 Markdown 到离屏节点，
  // 触发 react-markdown / remark / rehype-katex / KaTeX / CSS / font 的首次执行路径。
  useEffect(() => {
    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.left = '-10000px'
    host.style.top = '-10000px'
    host.style.width = '700px'
    host.style.opacity = '0'
    host.style.pointerEvents = 'none'
    document.body.appendChild(host)

    const root = createRoot(host)
    let cleanedUp = false

    const warmupMarkdown = [
      '# 预热标题',
      '',
      '**加粗** 与 *斜体* 文本，`inline code`。',
      '',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      '```js',
      'const x = 1 + 2;',
      'console.log(x);',
      '```',
      '',
      '行内公式 $x$ 与 $\\frac{1}{2}$，以及 $\\sqrt{x}$。',
      '',
      '块级公式：',
      '',
      '$$',
      '\\frac{a}{b} + \\sqrt{c} = \\sum_{i=1}^{n} x_i',
      '$$',
    ].join('\n')

    root.render(<MarkdownRenderer>{warmupMarkdown}</MarkdownRenderer>)

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      try { root.unmount() } catch {}
      host.remove()
    }

    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cleanup()
      })
    })

    return () => {
      cancelAnimationFrame(raf1)
      cleanup()
    }
  }, [])

  // Splash 结束：持久状态 + 双向握手。
  // 1) 先注册 onFinishSplash listener（push 快速路径）。
  // 2) 注册完成后显式 notifyRendererReady —— Main 只在此后才发 finish，杜绝「send 早于 listener」丢失。
  // 3) 主动 getBootState 拉取（pull 补救路径）：即便错过 push，也能据 canFinish 立即结束 Splash。
  // 4) 安全网定时轮询 getBootState，直到成功完成一次切换。
  // 所有 finish 操作幂等（finishBootSplash 内部去重）。
  useEffect(() => {
    let cancelled = false
    let finished = false

    const doFinish = (src: string) => {
      if (cancelled || finished) return
      finished = true
      rlog(`splash finish via ${src}`)
      // 立刻向 Main 确认，停止其 resend 兜底（不改变完成条件，仅去噪）。
      window.openchat.app.ackFinishSplash()
      finishBootSplash()
    }

    // 先注册 listener
    const cleanupFinish = window.openchat.app.onFinishSplash(() => {
      rlog('BOOT_FINISH_SPLASH received')
      doFinish('push')
    })
    rlog('finish listener registered')

    // 再声明 ready（顺序严格：listener 必先于 ready）
    window.openchat.app.notifyRendererReady()
    rlog('renderer ready sent')

    // 主动拉取一次（覆盖「push 已发出但早于 listener」的历史丢失）
    const applyState = (state: { canFinish: boolean; servicesReady: boolean; initError: { timedOut: boolean; message: string } | null }, src: string) => {
      rlog(`BOOT_GET_STATE response canFinish=${state.canFinish} servicesReady=${state.servicesReady} initError=${state.initError ? 'yes' : 'no'}`)
      if (cancelled) return
      // 持久错误态：即便错过 BOOT_INIT_ERROR push，也能进入降级界面。
      if (state.initError) setInitError(state.initError)
      if (state.canFinish) doFinish(src)
    }

    window.openchat.app.getBootState().then((state) => applyState(state, 'get-state-initial'))
      .catch(() => { /* 拉取失败由安全网轮询重试 */ })

    // 安全网轮询：直到完成一次切换。间隔见 RENDERER_BOOT_STATE_POLL_MS。
    const poll = window.setInterval(() => {
      if (cancelled || finished) { window.clearInterval(poll); return }
      window.openchat.app.getBootState().then((state) => applyState(state, 'get-state-poll'))
        .catch(() => { /* 忽略，下轮再试 */ })
    }, RENDERER_BOOT_STATE_POLL_MS)

    // 首帧渲染完成通知主进程（APP_READY）。语义为「可结束的许可」，而非「已就绪」。
    window.openchat.app.notifyReady()
    rlog('APP_READY sent')

    return () => {
      cancelled = true
      window.clearInterval(poll)
      cleanupFinish()
    }
  }, [])

  // 初始化失败 / 超时：订阅 Main 推送的错误态，切到降级界面。
  useEffect(() => {
    const cleanup = window.openchat.app.onInitError((payload) => {
      rlog(`init-error received: timedOut=${payload.timedOut} message=${payload.message}`)
      setInitError(payload)
    })
    return () => { cleanup() }
  }, [setInitError])

  // 初始化认证和模型
  useEffect(() => {
    // services-ready 驱动的统一数据初始化：会话列表 / Provider / Usage / 认证。
    // 幂等：可在「首次挂载」与「Main services 就绪推送」两个时机调用（含 Retry 成功场景）。
    // 关键：会话列表不在 mount 时一次性加载 —— 若 Main services 尚未就绪，IPC 返回空数组，
    // 会被误记为「已加载」；改为等 services-ready（或 getBootState().servicesReady）后再加载。
    const hydrateApplicationData = async () => {
      rlog('hydrate: conversations.list')
      try {
        const list = await window.openchat.conversations.list()
        useConversationStore.getState().setSummaries(list)
      } catch (err) {
        rlog(`hydrate: conversations.list failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 订阅务必无条件建立（不受下方一次性去重影响），否则 StrictMode 第二次 mount 会丢失监听。
    const cleanupServicesReady = window.openchat.app.onServicesReady(() => {
      rlog('services-ready received → hydrate')
      // services 真正就绪：清除任何先前的初始化错误态（超时后底层 attempt 最终成功、
      // 或 Retry 成功），使界面从错误页自愈回到主界面。
      setInitError(null)
      hydrateApplicationData()
      loadProviders()
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
        // 用户登出：清空 HAST 缓存，旧缓存内容属于前一会话
        hastCacheClear()
      }
    })

    // 一次性拉取组：StrictMode 会 mount→unmount→mount 执行两次 effect，
    // 用 ref 保证认证 / 模型 / Provider / Usage 的首次拉取只发起一次（生产不受影响）。
    if (!bootInitStartedRef.current) {
      bootInitStartedRef.current = true

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

      loadProviders()

      // 会话列表：只在 services 就绪后加载（避免拿到空数组）。
      window.openchat.app.getBootState().then((state) => {
        if (state.servicesReady) hydrateApplicationData()
      }).catch(() => { /* 忽略，等服务-ready 推送 */ })

      // 初始化 Codex Usage 状态
      window.openchat.codexUsage.get().then((view) => {
        useCodexUsageStore.getState().setUsage(view)
      })
    }

    // Provider / Usage 初始化（services-ready 前可能为空列表/unknown，就绪后由推送再次刷新）
    function loadProviders() {
      window.openchat.providers.list().then((list) => {
        useProviderStore.getState().setProviders(list as SafeProviderConfig[])
      })
    }

    return () => {
      cleanupServicesReady()
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

      // 先持久化 reasoningText 到消息，再清空——与 completion 路径一致
      const finalReasoningText = reasoningTextAccum || useChatStreamStore.getState().reasoningText

      // 仅当事件所属会话正是当前激活会话时才更新 activeMessages
      const activeConvId = useConversationStore.getState().activeConversationId
      const eventConvId = e.conversationId
      if (eventConvId && eventConvId !== activeConvId) {
        console.log('[App chat-error] SKIP message update: event conv %s != active conv %s', eventConvId, activeConvId)
      } else {
        // 标记当前进行中的 assistant 消息为失败（status 为 pending 的才属于本次发送，
        // 避免把历史已 completed 的消息误标为 failed）
        const messages = useConversationStore.getState().activeMessages
        const lastAssistantIdx = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') return i
          }
          return -1
        })()
        if (lastAssistantIdx >= 0 && messages[lastAssistantIdx].status !== 'completed' && messages[lastAssistantIdx].status !== 'failed') {
          const updated = [...messages]
          const streamState = useChatStreamStore.getState()
          updated[lastAssistantIdx] = {
            ...updated[lastAssistantIdx],
            status: 'failed',
            reasoningText: finalReasoningText || streamState.reasoningText || updated[lastAssistantIdx].reasoningText,
            errorCode: e.errorCode ?? 'StreamFailed',
            errorMessage: e.errorMessage ?? 'Unknown error',
          }
          useConversationStore.getState().setActiveMessages(updated)
        }
      }

      // 始终暂存错误信息到 store：当错误事件先于消息追加（handleSend 的 await 续体
      // 是 microtask，晚于同步的 IPC 事件回调）时，handleSend 恢复后据此标记新消息
      useChatStreamStore.getState().setStreamError(
        e.errorCode ?? 'StreamFailed',
        e.errorMessage ?? 'Unknown error'
      )

      // 只清除流式状态，不 reset（保留 webSearchStatus 等）
      accumulatedText = ''
      pendingDeltas.length = 0
      reasoningTextAccum = ''
      useChatStreamStore.getState().setStatus('idle')
      useChatStreamStore.getState().setStreamingConversationId(null)
      useChatStreamStore.getState().setStreamingAssistantMessageId(null)
      useChatStreamStore.getState().setActiveAssistantMessage(null)
      useChatStreamStore.getState().setBufferedText('')
      useChatStreamStore.getState().setReasoningStatus('idle')
      useChatStreamStore.getState().setReasoningText('')
    }))

    // 图片生成事件：独立于 chat 流式路径，只更新 imageGenerationStore + 重载消息
    // （生成结果通过 message_attachments 落库，完成后需要从 Main 重新拉取才能拿到 attachments）
    const reloadActiveConversation = async (conversationId: string) => {
      const activeConvId = useConversationStore.getState().activeConversationId
      if (conversationId !== activeConvId) return
      const data = await window.openchat.conversations.get(conversationId)
      if (data) {
        useConversationStore.getState().setActiveConversation(data.conversation)
        useConversationStore.getState().setActiveMessages(data.messages)
        useConversationStore.getState().setActiveSegments(data.segments)
      }
    }

    disposers.push(window.openchat.events.onImageGenerationStarted((event: unknown) => {
      const e = event as { conversationId: string; assistantMessageId: string; size?: string | null }
      console.log('[App RAW] image-generation-started conversationId=%s messageId=%s', e.conversationId, e.assistantMessageId)
      useImageGenerationStore.getState().setStarted(e.conversationId, e.assistantMessageId, e.size ?? null)
    }))

    disposers.push(window.openchat.events.onImageGenerationCompleted((event: unknown) => {
      const e = event as { conversationId: string }
      console.log('[App RAW] image-generation-completed conversationId=%s', e.conversationId)
      const store = useImageGenerationStore.getState()
      // 仅当完成的正是当前跟踪的生成时才清理，避免跨会话误清
      if (store.conversationId && store.conversationId !== e.conversationId) return
      useImageGenerationStore.getState().setCompleted(e.conversationId)
      void reloadActiveConversation(e.conversationId)
      window.openchat.conversations.list().then((list) => {
        useConversationStore.getState().setSummaries(list)
      })
    }))

    disposers.push(window.openchat.events.onImageGenerationFailed((event: unknown) => {
      const e = event as { conversationId: string }
      console.log('[App RAW] image-generation-failed conversationId=%s', e.conversationId)
      const store = useImageGenerationStore.getState()
      if (store.conversationId && store.conversationId !== e.conversationId) return
      // 失败原因已写入 assistant message，重载后由 AssistantMessage 内联展示。
      useImageGenerationStore.getState().setFailed(e.conversationId)
      void reloadActiveConversation(e.conversationId)
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
      }

      // Completion handoff: 先提交 message.content + status='completed'
      // 到 conversationStore（同一 setActiveMessages 原子写入），
      // rawContent 以 message.status 为准，一旦 completed 就不再拼 bufferedText。
      // 然后再清 bufferedText + reset，避免依赖 React batching 的 set 调用顺序。
      const finalContent = accumulatedText
      const finalReasoningText = reasoningTextAccum || useChatStreamStore.getState().reasoningText

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
            content: finalContent || updated[lastAssistantIdx].content,
            reasoningMeta: streamState.reasoningMeta ?? updated[lastAssistantIdx].reasoningMeta,
            reasoningText: finalReasoningText || streamState.reasoningText || updated[lastAssistantIdx].reasoningText,
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

      // 清理流式状态：message 已 commit，清 bufferedText 和 reset
      useChatStreamStore.getState().setBufferedText('')
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

  // 性能诊断：longtask 监听
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            console.log('[perf] longtask|duration=%dms startTime=%dms name=%s',
              Math.round(entry.duration), Math.round(entry.startTime),
              entry.name)
          }
        }
      })
      obs.observe({ type: 'longtask', buffered: true })
      return () => obs.disconnect()
    } catch {
      // longtask not supported
    }
  }, [])

  // 性能诊断：会话切换后输出 Markdown HAST cache 统计
  useEffect(() => {
    if (!activeConversationId) return
    // 延迟输出：等待 React 渲染完成（缓存写入在渲染中进行）
    const timer = setTimeout(() => {
      const stats = hastCacheStats()
      console.log('[perf] markdown-cache|size=%d hit=%d miss=%d',
        stats.size, stats.hitCount, stats.missCount)
      hastCacheResetStats()
    }, 500)
    return () => clearTimeout(timer)
  }, [activeConversationId])

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

  // 初始化失败 / 超时：进入降级错误界面，不渲染正常主界面。
  if (initError) {
    return <InitErrorScreen />
  }

  return (
    <div className="app-container">
      <Sidebar />
      <ChatView />
      {conversationSettingsOpen && <ConversationSettingsDialog />}
      {settingsDialogOpen && <SettingsDialog />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}