import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { MessageItem } from './MessageItem'
import { ContextBoundary } from './ContextBoundary'
import { MessageListContextMenu } from './MessageListContextMenu'
import { ScrollContainerContext, type ScrollFollowMode } from './ScrollContainerContext'
import { probeLayoutRead, isConversationSwitchDiagActive, switchTimingMark, switchTimingDetail, switchTimingEnd, renderTimingBegin, renderTimingMark, renderTimingPrint, logEffectRun, logResizeObserver } from '../../packages/layoutReadDiag'
import { keepAliveUnmount, DIAG_PANE_RENDERING_ISOLATION } from '../../packages/conversationKeepAlive'
import type { Conversation, ContextSegment, Message } from '../../../shared/types/conversation'

const PINNED_THRESHOLD = 80
const SHOW_BUTTON_THRESHOLD = 300

interface MessageListProps {
  // Keep-alive 模式下传入 snapshot，不订阅全局 active store
  conversationId?: string
  snapshotConversation?: Conversation | null
  snapshotMessages?: Message[]
  snapshotSegments?: ContextSegment[]
  // hidden pane 必须停止所有 active-only effect（scroll/ResizeObserver/streamStatus follow）
  isActivePane?: boolean
}

export function MessageList({
  conversationId,
  snapshotConversation,
  snapshotMessages,
  snapshotSegments,
  isActivePane = true,
}: MessageListProps = {}) {
  // 若提供 snapshot 则用 snapshot，否则回退到原始 store 订阅（向后兼容）
  const storeMessages = useConversationStore((s) => s.activeMessages)
  const storeSegments = useConversationStore((s) => s.activeSegments)
  const storeActiveConversation = useConversationStore((s) => s.activeConversation)
  const streamStatus = useChatStreamStore((s) => s.status)

  const messages = snapshotMessages ?? storeMessages
  const segments = snapshotSegments ?? storeSegments
  const activeConversation = snapshotConversation ?? storeActiveConversation

  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // 诊断：isActivePane false→true 触发检测。
  // 每个 effect 持有自己的 prev 值，在 effect 内更新——避免「激活后又因无关 re-render
  // 保持 true」的误报。justActivated 判定：上次运行是 false、本次是 true。
  const prevActiveMsgsRef = useRef(isActivePane)
  const prevActiveConvIdRef = useRef(isActivePane)
  const prevActiveStreamRef = useRef(isActivePane)
  const prevActiveResizeRef = useRef(isActivePane)

  // Keep-alive 诊断：mount/unmount 日志
  useEffect(() => {
    const __t0 = performance.now()
    if (conversationId) {
      console.log('[keepalive] messagelist mount id=%s', conversationId.slice(0, 8))
      logEffectRun('mount', conversationId, false, __t0)
      return () => {
        console.log('[keepalive] messagelist unmount id=%s', conversationId.slice(0, 8))
        keepAliveUnmount(conversationId)
      }
    }
  }, [conversationId])

  const [contextMenu, setContextMenu] = useState<{ visible: boolean; x: number; y: number }>({
    visible: false, x: 0, y: 0,
  })

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    e.preventDefault()
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0 })
  }, [])

  // 滚动跟随状态机：FOLLOWING / READING_HISTORY
  const followModeRef = useRef<ScrollFollowMode>('FOLLOWING')
  const pinnedRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // 程序滚动目标：设置 scrollTop 前记录目标位置，handleScroll 比较实际值区分程序/用户滚动
  const programmaticScrollTargetRef = useRef<number | null>(null)

  // keep-alive restore 检测：hidden→visible 复用 pane 时 messages/segments 引用不变，
  // 此时应保留已有 scrollTop，不主动触底（避免对大 DOM 触发 forced reflow）。
  // 首次 mount 时 messages 为 undefined，contentChanged 为 true，正常触底。
  const lastContentRef = useRef<{ messages?: Message[]; segLen: number }>({ segLen: -1 })

  const scrollToBottom = () => {
    if (!isActivePane) return  // hidden pane 不读/写 geometry
    if (isConversationSwitchDiagActive()) {
      // 诊断消融：会话切换窗口内跳过自动触底 geometry read/write
      return
    }
    const list = listRef.current
    if (!list) return
    let t0 = performance.now()
    const scrollHeight = list.scrollHeight
    probeLayoutRead(t0, 'MessageList.scrollToBottom', 'scrollHeight')
    t0 = performance.now()
    const clientHeight = list.clientHeight
    probeLayoutRead(t0, 'MessageList.scrollToBottom', 'clientHeight')
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
    t0 = performance.now()
    const scrollTop = list.scrollTop
    probeLayoutRead(t0, 'MessageList.scrollToBottom', 'scrollTop')
    if (Math.abs(scrollTop - maxScrollTop) <= 1) return
    programmaticScrollTargetRef.current = maxScrollTop
    list.scrollTop = maxScrollTop
  }

  // 滚动控制器（通过 Context 暴露给 ReasoningPanel）
  const scrollControl = useMemo(() => ({
    enterReadingMode: (reason: string) => {
      console.log('[Scroll] enterReadingMode reason=%s', reason)
      followModeRef.current = 'READING_HISTORY'
      pinnedRef.current = false
      setShowScrollToBottom(true)
    },
    resumeFollowing: () => {
      followModeRef.current = 'FOLLOWING'
      pinnedRef.current = true
      scrollToBottom()
      setShowScrollToBottom(false)
    },
    getMode: () => followModeRef.current,
  }), [])

  // 点击"回到底部"按钮：显式恢复 FOLLOWING
  const handleScrollToBottomClick = useCallback(() => {
    followModeRef.current = 'FOLLOWING'
    pinnedRef.current = true
    scrollToBottom()
    setShowScrollToBottom(false)
  }, [])

  // messages/segments 变化时统一走 tryAutoScroll
  useEffect(() => {
    const __t0 = performance.now()
    const __justActivated = isActivePane && !prevActiveMsgsRef.current
    prevActiveMsgsRef.current = isActivePane
    if (!isActivePane) return  // hidden pane 不触发 auto-scroll
    if (isConversationSwitchDiagActive()) {
      logEffectRun('msgsEffect(diagSkip)', conversationId, __justActivated, __t0)
      return
    }

    // keep-alive restore：hidden→visible 复用 pane 时内容引用未变，不主动触底
    // （大 DOM 上 scrollToBottom 的 scrollHeight 读取会触发 forced reflow）
    const segLen = segments.length
    const prevContent = lastContentRef.current
    const contentChanged = prevContent.messages !== messages || prevContent.segLen !== segLen
    lastContentRef.current = { messages, segLen }
    if (!contentChanged) {
      logEffectRun('msgsEffect(noContentChange)', conversationId, __justActivated, __t0)
      return
    }

    if (followModeRef.current === 'FOLLOWING' && pinnedRef.current) {
      scrollToBottom()
    } else {
      const list = listRef.current
      if (list) {
        let t0 = performance.now()
        const scrollHeight = list.scrollHeight
        probeLayoutRead(t0, 'MessageList.msgsEffect', 'scrollHeight')
        t0 = performance.now()
        const scrollTop = list.scrollTop
        probeLayoutRead(t0, 'MessageList.msgsEffect', 'scrollTop')
        t0 = performance.now()
        const clientHeight = list.clientHeight
        probeLayoutRead(t0, 'MessageList.msgsEffect', 'clientHeight')
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight
        setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)
      }
    }
    logEffectRun('msgsEffect(contentChanged)', conversationId, __justActivated, __t0)
  }, [messages, segments.length, isActivePane])

  // 切换会话时重置到 FOLLOWING 并滚到底部
  // keep-alive reuse (isActivePane 从 false→true) 不重置 scrollTop，保留原位
  useEffect(() => {
    const __t0 = performance.now()
    const __justActivated = isActivePane && !prevActiveConvIdRef.current
    prevActiveConvIdRef.current = isActivePane
    if (!isActivePane) return  // hidden pane 不响应 activeConversation 变化
    followModeRef.current = 'FOLLOWING'
    pinnedRef.current = true
    programmaticScrollTargetRef.current = null
    scrollToBottom()
    logEffectRun('convIdEffect', conversationId, __justActivated, __t0)
  }, [activeConversation?.id])

  // 新消息发送时（streamStatus 变为 starting）重置到 FOLLOWING 并滚到底部
  useEffect(() => {
    const __t0 = performance.now()
    const __justActivated = isActivePane && !prevActiveStreamRef.current
    prevActiveStreamRef.current = isActivePane
    if (!isActivePane) return  // hidden pane 不响应全局 stream 状态
    if (streamStatus === 'starting') {
      followModeRef.current = 'FOLLOWING'
      pinnedRef.current = true
      programmaticScrollTargetRef.current = null
      scrollToBottom()
    }
    logEffectRun('streamStatusEffect', conversationId, __justActivated, __t0)
  }, [streamStatus, isActivePane])

  // Keep-alive scroll restore
  // 根因：paneIds 恒为 [current, previous]，B→A 时顺序翻转 [B,A]→[A,B]，
  // React keyed diff 需 insertBefore 移动复用的 A pane；scroll 容器被 detach/re-insert
  // 会把 scrollTop 重置为 0（代码里并无显式 scrollTop=0）。
  // 且 React 重排后 layout 处于 dirty 态，在 useLayoutEffect 里写 scrollTop 会 flush
  // 整棵大 DOM 的 layout（实测 restoreWriteCost 195~257ms）。
  // 因此：pane active 期间用 scroll 监听持续记录 scrollTop；pane 重新 active 时延迟到
  // paint 之后（双 rAF，layout 已 clean）再写，写入不再触发 forced layout；
  // restore 期间保持 viewport hidden，避免用户看到顶部闪烁。
  // 首帧：saved=null → 不恢复，保持原有自动到底部逻辑。
  const savedScrollTopRef = useRef<number | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  // restore 窗口内忽略滚动事件：scrollTop 归零/恢复产生的 scroll 事件不应被当成用户滚动
  const restoringRef = useRef(false)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    if (!isActivePane) return

    // 分阶段埋点：pane-visible（layout effect 在 DOM mutation 后、paint 前同步执行）
    if (conversationId) switchTimingMark(conversationId, 'pane-visible')

    // pane active 期间持续记录（用户滚动 / 程序滚动均派发 scroll 事件）
    // restore 窗口内忽略：DOM 重排归零产生的 scroll 事件不应污染的记录值
    const onScroll = () => {
      if (restoringRef.current) return
      savedScrollTopRef.current = list.scrollTop
    }
    list.addEventListener('scroll', onScroll)

    const saved = savedScrollTopRef.current
    if (saved == null) {
      // 首次 mount：无 saved，无 restore，保持原有自动到底部逻辑
      if (conversationId) {
        switchTimingMark(conversationId, 'restore-end')
        switchTimingMark(conversationId, 'finish')
        switchTimingEnd(conversationId)
      }
      return () => list.removeEventListener('scroll', onScroll)
    }

    // 诊断：开启 render stage 时间线（paneVisible 起点）
    if (conversationId) {
      renderTimingBegin(conversationId, DIAG_PANE_RENDERING_ISOLATION ? 'isolation' : 'baseline')
      renderTimingMark(conversationId, 'pane-visible')
    }

    // 延迟恢复：先隐藏，等本帧 layout/paint 完成后再写 scrollTop
    const viewport = viewportRef.current
    restoringRef.current = true
    if (viewport) viewport.style.visibility = 'hidden'

    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      if (conversationId) renderTimingMark(conversationId, 'raf1')
      raf2 = requestAnimationFrame(() => {
        if (conversationId) renderTimingMark(conversationId, 'raf2')
        const l = listRef.current
        programmaticScrollTargetRef.current = saved
        const tw = performance.now()
        if (l) l.scrollTop = saved
        const writeCost = performance.now() - tw
        restoringRef.current = false
        if (conversationId) renderTimingMark(conversationId, 'vis-before')
        if (viewport) viewport.style.visibility = ''
        if (conversationId) renderTimingMark(conversationId, 'vis-after')
        if (conversationId) {
          switchTimingDetail(conversationId, 'restore-read-cost', 0)
          switchTimingDetail(conversationId, 'restore-write-cost', writeCost)
          switchTimingMark(conversationId, 'restore-end')
          switchTimingMark(conversationId, 'finish')
          switchTimingEnd(conversationId)
          // 下一帧时间点：观察 visibility 恢复后到下一次 rAF 的间隔
          requestAnimationFrame(() => {
            renderTimingMark(conversationId, 'next-frame')
            renderTimingPrint(conversationId)
          })
        }
      })
    })

    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      restoringRef.current = false
      if (viewport) viewport.style.visibility = ''
      list.removeEventListener('scroll', onScroll)
    }
  }, [isActivePane, conversationId])

  // 用户滚动意图时间戳（ms）：wheel/touchmove/滚动键 标记 now()，
  // handleScroll 消费一次后清零，超过 250ms 自动失效。
  const userScrollIntentUntilRef = useRef(0)
  const scrollbarDraggingRef = useRef(false)

  // 监听用户滚动：区分程序滚动与用户滚动
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const markIntent = () => { userScrollIntentUntilRef.current = performance.now() + 250 }
    const onWheel = markIntent
    const onTouchMove = markIntent
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return
      const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
      if (scrollKeys.has(e.key)) {
        markIntent()
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      let t0 = performance.now()
      const offsetWidth = list.offsetWidth
      probeLayoutRead(t0, 'MessageList.onPointerDown', 'offsetWidth')
      t0 = performance.now()
      const clientWidth = list.clientWidth
      probeLayoutRead(t0, 'MessageList.onPointerDown', 'clientWidth')
      const scrollbarWidth = offsetWidth - clientWidth
      if (scrollbarWidth <= 0) return
      t0 = performance.now()
      const rect = list.getBoundingClientRect()
      probeLayoutRead(t0, 'MessageList.onPointerDown', 'getBoundingClientRect')
      const isInScrollbarGutter = e.clientX - rect.left >= rect.width - scrollbarWidth
      if (isInScrollbarGutter) {
        scrollbarDraggingRef.current = true
      }
    }
    const onPointerUp = () => { scrollbarDraggingRef.current = false }

    list.addEventListener('wheel', onWheel, { passive: true })
    list.addEventListener('touchmove', onTouchMove, { passive: true })
    list.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('blur', onPointerUp)
    document.addEventListener('keydown', onKeyDown)

    const handleScroll = () => {
      // restore 窗口内（DOM 重排导致 scrollTop 归零 → 双 rAF 后恢复）产生的 scroll 事件
      // 不是用户滚动，直接忽略，避免误改 followMode
      if (restoringRef.current) return
      const target = programmaticScrollTargetRef.current
      if (target !== null) {
        let t0 = performance.now()
        const scrollTop = list.scrollTop
        probeLayoutRead(t0, 'MessageList.handleScroll', 'scrollTop')
        const isProgrammatic = Math.abs(scrollTop - target) <= 1
        programmaticScrollTargetRef.current = null
        if (isProgrammatic) return
      }
      let t0 = performance.now()
      const scrollHeight = list.scrollHeight
      probeLayoutRead(t0, 'MessageList.handleScroll', 'scrollHeight')
      t0 = performance.now()
      const scrollTop = list.scrollTop
      probeLayoutRead(t0, 'MessageList.handleScroll', 'scrollTop')
      t0 = performance.now()
      const clientHeight = list.clientHeight
      probeLayoutRead(t0, 'MessageList.handleScroll', 'clientHeight')
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const nearBottom = distanceFromBottom < PINNED_THRESHOLD
      const hasRecentIntent = userScrollIntentUntilRef.current > performance.now()
      const isScrollbarDrag = scrollbarDraggingRef.current

      pinnedRef.current = nearBottom
      setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)

      if (!nearBottom && followModeRef.current === 'FOLLOWING') {
        followModeRef.current = 'READING_HISTORY'
      }
      if (nearBottom && followModeRef.current === 'READING_HISTORY' && (hasRecentIntent || isScrollbarDrag)) {
        followModeRef.current = 'FOLLOWING'
        userScrollIntentUntilRef.current = 0
        scrollbarDraggingRef.current = false
      }
    }
    list.addEventListener('scroll', handleScroll)
    return () => {
      list.removeEventListener('scroll', handleScroll)
      list.removeEventListener('wheel', onWheel)
      list.removeEventListener('touchmove', onTouchMove)
      list.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('blur', onPointerUp)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // 监听内容高度变化：流式期间跟随，非跟随态只更新按钮
  useEffect(() => {
    const __t0 = performance.now()
    const __justActivated = isActivePane && !prevActiveResizeRef.current
    prevActiveResizeRef.current = isActivePane
    if (!isActivePane) return  // hidden pane 不需要 ResizeObserver auto-follow
    const list = listRef.current
    const content = contentRef.current
    if (!list || !content) return
    logEffectRun('resizeObserverSetup', conversationId, __justActivated, __t0)

    const isStreaming = streamStatus === 'streaming' || streamStatus === 'starting'
    const observer = new ResizeObserver(() => {
      const cbT0 = performance.now()
      let layoutReadCost = 0
      if (isConversationSwitchDiagActive()) {
        logResizeObserver(conversationId, performance.now() - cbT0, 0, false)
        return
      }
      if (!isActivePane) {
        logResizeObserver(conversationId, performance.now() - cbT0, 0, false)
        return  // double-check: hidden pane 不读 geometry
      }
      if (isStreaming && followModeRef.current === 'FOLLOWING' && pinnedRef.current) {
        const st0 = performance.now()
        scrollToBottom()
        // scrollToBottom 内部有 scrollHeight/clientHeight/scrollTop 读取，计入 layoutReadCost
        layoutReadCost += performance.now() - st0
        setShowScrollToBottom(false)
        logResizeObserver(conversationId, performance.now() - cbT0, layoutReadCost, true)
        return
      }
      let t0 = performance.now()
      const scrollHeight = list.scrollHeight
      probeLayoutRead(t0, 'MessageList.resizeObserver', 'scrollHeight')
      layoutReadCost += performance.now() - t0
      t0 = performance.now()
      const scrollTop = list.scrollTop
      probeLayoutRead(t0, 'MessageList.resizeObserver', 'scrollTop')
      layoutReadCost += performance.now() - t0
      t0 = performance.now()
      const clientHeight = list.clientHeight
      probeLayoutRead(t0, 'MessageList.resizeObserver', 'clientHeight')
      layoutReadCost += performance.now() - t0
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      pinnedRef.current = distanceFromBottom < PINNED_THRESHOLD
      setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)
      logResizeObserver(conversationId, performance.now() - cbT0, layoutReadCost, false)
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [streamStatus, isActivePane])

  // segment 边界
  const segmentBoundaries = new Set<number>()
  let currentSegmentId = ''
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].segmentId !== currentSegmentId) {
      currentSegmentId = messages[i].segmentId
      segmentBoundaries.add(i)
    }
  }

  const currentSegment = activeConversation
    ? segments.find((s) => s.id === activeConversation.currentSegmentId)
    : null
  const showTrailingBoundary =
    currentSegment &&
    currentSegment.reason !== 'conversation-created' &&
    (messages.length === 0 || messages[messages.length - 1].segmentId !== currentSegment.id)

  return (
    <ScrollContainerContext.Provider value={scrollControl}>
    <div className="message-list-viewport" data-conversation-pane={conversationId} ref={viewportRef}>
    <div className="message-list" ref={listRef} onContextMenu={handleContextMenu}>
      <div ref={contentRef}>
        {messages.length === 0 && !showTrailingBoundary ? (
          <div className="messages-empty">
            <div className="messages-empty-icon">
              <div className="messages-empty-bubble">
                <span className="messages-empty-dot" />
                <span className="messages-empty-dot" />
                <span className="messages-empty-dot" />
              </div>
            </div>
            <div className="messages-empty-title">开始对话</div>
            <div className="messages-empty-hint">在下方输入消息，开启一段新的对话</div>
          </div>
        ) : (
          <>
            {messages.map((msg, index) => {
              const isBoundary = index > 0 && segmentBoundaries.has(index)
              const segment = segments.find((s) => s.id === msg.segmentId)
              return (
                <React.Fragment key={msg.id}>
                  {isBoundary && segment && <ContextBoundary segment={segment} />}
                  <MessageItem message={msg} />
                </React.Fragment>
              )
            })}
            {showTrailingBoundary && currentSegment && <ContextBoundary segment={currentSegment} />}
          </>
        )}
      </div>
      <MessageListContextMenu
        visible={contextMenu.visible}
        x={contextMenu.x}
        y={contextMenu.y}
        onClose={closeContextMenu}
      />
    </div>
      {showScrollToBottom && (
        <button
          className="scroll-to-bottom-btn"
          onClick={handleScrollToBottomClick}
          aria-label="回到底部"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v10" />
            <path d="M3 8l5 5 5-5" />
          </svg>
        </button>
      )}
    </div>
    </ScrollContainerContext.Provider>
  )
}