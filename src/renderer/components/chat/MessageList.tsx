import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { MessageItem } from './MessageItem'
import { ContextBoundary } from './ContextBoundary'
import { MessageListContextMenu } from './MessageListContextMenu'
import { ScrollContainerContext, type ScrollFollowMode } from './ScrollContainerContext'

// 距离底部的阈值：用于判断"是否贴底"（仅影响按钮显示与 FOLLOWING 判定）
const PINNED_THRESHOLD = 80
// 显示"回到底部"按钮的距离阈值
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

  // 滚动跟随状态机：FOLLOWING / READING_HISTORY / MANUAL_PAUSED
  const followModeRef = useRef<ScrollFollowMode>('FOLLOWING')
  // 是否接近底部：仅用于 UI 按钮显示与 FOLLOWING 判定，不单独决定是否自动滚动
  const pinnedRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // 程序滚动目标：scrollToBottom 在设置 scrollTop 前记录目标位置，
  // handleScroll 通过比较实际 scrollTop 与目标来区分程序滚动和用户滚动。
  const programmaticScrollTargetRef = useRef<number | null>(null)

  const scrollToBottom = () => {
    const list = listRef.current
    if (!list) return
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight)
    if (Math.abs(list.scrollTop - maxScrollTop) <= 1) return
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
    if (followModeRef.current === 'FOLLOWING' && pinnedRef.current) {
      scrollToBottom()
    } else {
      const list = listRef.current
      if (list) {
        const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
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
  // 短期意图窗口确保：未产生 scroll 的输入不会残留脏状态，
  // 且 DOM/reasoning 被动 scroll 永远不能使用过期的用户意图恢复 FOLLOWING。
  const userScrollIntentUntilRef = useRef(0)

  // 滚动条拖动状态：true 期间产生的 scroll 视为真实用户滚动。
  // 仅通过 pointerdown 在 scrollbar gutter 区域命中时设置，pointerup/cancel 时恢复。
  const scrollbarDraggingRef = useRef(false)

  // 监听用户滚动：区分程序滚动与用户滚动
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    // wheel / touchmove / 滚动键：标记用户滚动意图，250ms 窗口内持续有效，
    // 新的用户输入会刷新时间。不在 scroll 事件里清零——一个手势可能产生多个连续
    // scroll 事件，只有成功 resumeFollowing() 时才立即清零。
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
    // 滚动条拖动检测：仅当 pointerdown 落在 scrollbar gutter 区域内时才标记。
    // 不监听整个容器的 pointerdown，避免普通点击消息正文制造假滚动意图。
    const onPointerDown = (e: PointerEvent) => {
      const scrollbarWidth = list.offsetWidth - list.clientWidth
      if (scrollbarWidth <= 0) return // macOS overlay scrollbar 无法可靠检测，不做危险猜测
      const rect = list.getBoundingClientRect()
      const isInScrollbarGutter = e.clientX - rect.left >= rect.width - scrollbarWidth
      if (isInScrollbarGutter) {
        scrollbarDraggingRef.current = true
      }
    }
    const onPointerUp = () => { scrollbarDraggingRef.current = false }
    // 使用 document 级 pointerup/cancel + window blur 作为清理手段，
    // 覆盖用户拖动滚动条后鼠标移出 MessageList、移出窗口、切换应用等场景。
    // 不能只依赖 list 上的 pointerup——若鼠标在容器外释放，事件不会冒泡到 list。
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
        const isProgrammatic = Math.abs(list.scrollTop - target) <= 1
        programmaticScrollTargetRef.current = null
        if (isProgrammatic) return
      }
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      const nearBottom = distanceFromBottom < PINNED_THRESHOLD
      const hasRecentIntent = userScrollIntentUntilRef.current > performance.now()
      const isScrollbarDrag = scrollbarDraggingRef.current

      pinnedRef.current = nearBottom
      setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)

      // 用户主动向上滚动（远离底部）→ 进入阅读历史模式
      if (!nearBottom && followModeRef.current === 'FOLLOWING') {
        followModeRef.current = 'READING_HISTORY'
      }
      // 只有近期用户滚动意图 + 滚回底部才恢复 FOLLOWING。
      // DOM 收缩/ResizeObserver/reasoning 产生的被动 scroll 没有 intent，不恢复。
      if (nearBottom && followModeRef.current === 'READING_HISTORY' && (hasRecentIntent || isScrollbarDrag)) {
        followModeRef.current = 'FOLLOWING'
        // 成功恢复后立即清零意图，避免残留
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
      if (isStreaming && followModeRef.current === 'FOLLOWING' && pinnedRef.current) {
        scrollToBottom()
        setShowScrollToBottom(false)
        return
      }
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      pinnedRef.current = distanceFromBottom < PINNED_THRESHOLD
      setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)
    })
    observer.observe(content)

    return () => observer.disconnect()
  }, [streamStatus])

  // 在 segment 边界处插入分割线
  const segmentBoundaries = new Set<number>()
  let currentSegmentId = ''
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].segmentId !== currentSegmentId) {
      currentSegmentId = messages[i].segmentId
      segmentBoundaries.add(i)
    }
  }

  // 当前 segment 是否需要在末尾显示边界（无消息或最后一条消息不属于当前 segment）
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
