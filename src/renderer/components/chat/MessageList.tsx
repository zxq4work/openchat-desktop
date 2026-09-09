import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { MessageItem } from './MessageItem'
import { ContextBoundary } from './ContextBoundary'
import { MessageListContextMenu } from './MessageListContextMenu'
import { ScrollContainerContext, type ScrollFollowMode } from './ScrollContainerContext'
import { probeLayoutRead, isConversationSwitchDiagActive } from '../../packages/layoutReadDiag'

const PINNED_THRESHOLD = 80
const SHOW_BUTTON_THRESHOLD = 300

export function MessageList() {
  const messages = useConversationStore((s) => s.activeMessages)
  const segments = useConversationStore((s) => s.activeSegments)
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const streamStatus = useChatStreamStore((s) => s.status)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

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

  const scrollToBottom = () => {
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
    if (isConversationSwitchDiagActive()) return
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
  }, [messages, segments.length])

  // 切换会话时重置到 FOLLOWING 并滚到底部
  useEffect(() => {
    followModeRef.current = 'FOLLOWING'
    pinnedRef.current = true
    programmaticScrollTargetRef.current = null
    scrollToBottom()
  }, [activeConversation?.id])

  // 新消息发送时（streamStatus 变为 starting）重置到 FOLLOWING 并滚到底部
  useEffect(() => {
    if (streamStatus === 'starting') {
      followModeRef.current = 'FOLLOWING'
      pinnedRef.current = true
      programmaticScrollTargetRef.current = null
      scrollToBottom()
    }
  }, [streamStatus])

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
    const list = listRef.current
    const content = contentRef.current
    if (!list || !content) return

    const isStreaming = streamStatus === 'streaming' || streamStatus === 'starting'
    const observer = new ResizeObserver(() => {
      if (isConversationSwitchDiagActive()) return
      if (isStreaming && followModeRef.current === 'FOLLOWING' && pinnedRef.current) {
        scrollToBottom()
        setShowScrollToBottom(false)
        return
      }
      let t0 = performance.now()
      const scrollHeight = list.scrollHeight
      probeLayoutRead(t0, 'MessageList.resizeObserver', 'scrollHeight')
      t0 = performance.now()
      const scrollTop = list.scrollTop
      probeLayoutRead(t0, 'MessageList.resizeObserver', 'scrollTop')
      t0 = performance.now()
      const clientHeight = list.clientHeight
      probeLayoutRead(t0, 'MessageList.resizeObserver', 'clientHeight')
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      pinnedRef.current = distanceFromBottom < PINNED_THRESHOLD
      setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [streamStatus])

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
    <div className="message-list-viewport">
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