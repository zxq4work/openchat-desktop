import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { MessageItem } from './MessageItem'
import { ContextBoundary } from './ContextBoundary'
import { MessageListContextMenu } from './MessageListContextMenu'

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

  // 用户是否处于“贴底”状态：只有在底部附近才自动跟随滚动，否则尊重用户向上滚动阅读
  const pinnedRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  const scrollToBottom = () => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }

  // 是否在底部附近
  const isNearBottom = useCallback(() => {
    const list = listRef.current
    if (!list) return true
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80
  }, [])

  // 点击“回到底部”按钮
  const handleScrollToBottomClick = useCallback(() => {
    pinnedRef.current = true
    scrollToBottom()
    setShowScrollToBottom(false)
  }, [])

  useEffect(() => {
    pinnedRef.current = true
    scrollToBottom()
  }, [messages.length, segments.length])

  // 监听用户滚动，判断是否贴底
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const handleScroll = () => {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      pinnedRef.current = distanceFromBottom < 80
      setShowScrollToBottom(distanceFromBottom >= 300)
    }
    list.addEventListener('scroll', handleScroll)
    return () => list.removeEventListener('scroll', handleScroll)
  }, [])

  // 监听内容高度变化（流式文本增长、思考过程展开/收起等），同步贴底状态与按钮显示
  // 流式期间且贴底时自动滚动到底部；非流式时只更新按钮状态，不强制滚动
  // 注意：必须观察内容包裹层（会随内容增长），而不是滚动容器（flex:1 高度固定，不会触发）
  useEffect(() => {
    const list = listRef.current
    const content = contentRef.current
    if (!list || !content) return

    const isStreaming = streamStatus === 'streaming' || streamStatus === 'starting'
    const observer = new ResizeObserver(() => {
      if (isStreaming && pinnedRef.current) {
        // 流式期间且贴底：先滚动到底部，再刷新按钮状态（此时距离必然很小）
        scrollToBottom()
        setShowScrollToBottom(false)
        return
      }
      // 非流式或非贴底：仅更新贴底状态与按钮，不强制滚动
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      pinnedRef.current = distanceFromBottom < 80
      setShowScrollToBottom(distanceFromBottom >= 300)
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
      <MessageListContextMenu
        visible={contextMenu.visible}
        x={contextMenu.x}
        y={contextMenu.y}
        onClose={closeContextMenu}
      />
    </div>
  )
}