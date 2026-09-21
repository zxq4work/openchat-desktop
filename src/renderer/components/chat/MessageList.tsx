import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useImageGenerationStore } from '../../stores/imageGenerationStore'
import { MessageItem } from './MessageItem'
import { ContextBoundary } from './ContextBoundary'
import { MessageListContextMenu } from './MessageListContextMenu'
import { ScrollContainerContext, type ScrollFollowMode } from './ScrollContainerContext'
import { probeLayoutRead, isConversationSwitchDiagActive } from '../../packages/layoutReadDiag'

const PINNED_THRESHOLD = 80
const SHOW_BUTTON_THRESHOLD = 300

// 首次进入会话时「定位到底部」意图的最长存活时间（ms）。
// 仅作兜底：正常情况下布局稳定后不再触发修正，用户一旦滚动则立即放弃。
const INITIAL_BOTTOM_SETTLE_MS = 1200

// 图片生成完成（pending placeholder → 最终图片 commit）后「贴底」意图的最长存活时间（ms）。
// 与首次进入会话的意图相互独立：只在一次生成真正结束时短暂开启，用户一旦滚动立即放弃。
const GENERATION_COMPLETION_SETTLE_MS = 1000

// 图片空状态 SVG 的 clipPath / gradient id 前缀。
// 同一时刻只渲染一个 MessageList（即单个空状态实例），用稳定专用 id 即可，无需引入 useId。
const imageClipId = 'openchat-image-empty'

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

  // 首次进入会话的「定位到底部」意图：会话切换后短暂开启。
  // 图片 decode 等异步布局变化会在首帧之后继续抬高 scrollHeight，
  // 此意图让这些后续变化仍把视图贴到底部，直到用户主动滚动或超过兜底时限。
  const initialBottomIntentRef = useRef(false)
  const initialBottomDeadlineRef = useRef(0)
  // 记录上次观察到的 scrollHeight，用于判断布局是否已稳定（连续不变即可提前结束意图）
  const lastObservedScrollHeightRef = useRef(-1)

  // 图片生成完成后的「补一次贴底」意图（独立于 initialBottomIntent，不共用 deadline）。
  // 仅在用户本就在底部跟随、且一次真实生成完成时短暂开启；任何用户滚动立即取消。
  const generationCompletionBottomIntentRef = useRef(false)
  const generationCompletionDeadlineRef = useRef(0)
  // 正在生成的 assistant 消息 id：只有它真正落图（出现 generation_output 附件）才补一次贴底。
  // 记录其所属会话，切换会话时清空，避免把「历史会话本就存在的图片」误判为一次新完成。
  const pendingImageGenMessageIdRef = useRef<string | null>(null)
  const imgGenTrackingConvIdRef = useRef<string | null>(null)
  // 上一次 commit 的「图片生成结果 key」，用于识别 空 → 非空 的真实落图跳变。
  const lastImageGenResultKeyRef = useRef('')

  // 用户滚动意图时间戳（ms）：wheel/touchmove/滚动键 标记 now()，
  // handleScroll 消费一次后清零，超过 250ms 自动失效。
  const userScrollIntentUntilRef = useRef(0)
  const scrollbarDraggingRef = useRef(false)

  // 统一的「首次定位到底部」意图读取入口：同时校验 ref 与 deadline。
  // deadline 到期即就地清 ref —— 即使没有额外 timer，任何过期后的读取都会得到 false，
  // 因此不存在「幽灵 intent 把用户拉回底部」的风险。
  const isInitialBottomIntentActive = () => {
    if (!initialBottomIntentRef.current) return false
    if (performance.now() > initialBottomDeadlineRef.current) {
      initialBottomIntentRef.current = false
      return false
    }
    return true
  }

  // 与上者同构：读取即校验 deadline，过期就地清除，避免「幽灵 intent」把用户拉回底部。
  const isGenerationCompletionBottomIntentActive = () => {
    if (!generationCompletionBottomIntentRef.current) return false
    if (performance.now() > generationCompletionDeadlineRef.current) {
      generationCompletionBottomIntentRef.current = false
      return false
    }
    return true
  }

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

  // 切换会话时重置到 FOLLOWING 并滚到底部。
  // 同时开启「首次定位到底部」意图：即便首帧后图片才 decode、scrollHeight 继续增长，
  // ResizeObserver 也会在用户未干预时继续贴底，避免停在半空。
  useEffect(() => {
    followModeRef.current = 'FOLLOWING'
    pinnedRef.current = true
    programmaticScrollTargetRef.current = null
    initialBottomIntentRef.current = true
    initialBottomDeadlineRef.current = performance.now() + INITIAL_BOTTOM_SETTLE_MS
    lastObservedScrollHeightRef.current = -1
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

  // 图片生成开始/结束：图片生成不走 chatStreamStore，需单独触发滚到底部
  const imageGenPhase = useImageGenerationStore((s) => s.phase)
  const imageGenActiveAssistantId = useImageGenerationStore((s) => s.activeAssistantMessageId)
  useEffect(() => {
    if (imageGenPhase === 'generating') {
      followModeRef.current = 'FOLLOWING'
      pinnedRef.current = true
      programmaticScrollTargetRef.current = null
      scrollToBottom()
    }
  }, [imageGenPhase])

  // 图片生成完成（pending placeholder → 最终图片）后的「补一次贴底」。
  // 与 initialBottomIntent 完全独立：仅在用户本就贴底跟随时，对真实落图做一次贴底修正。
  // 关键：用 useLayoutEffect —— 它在图片 commit 之后、浏览器派发 scroll 事件之前同步执行。
  // 若等被动 effect，内容增高引发的 scroll 事件会先把 pinnedRef/followModeRef 翻成
  // READING_HISTORY，之后任何自动贴底都不会触发，这正是「差一点到底」的根因。
  useLayoutEffect(() => {
    const convId = activeConversation?.id
    if (!convId) return

    // 切换会话：就地复位跟踪状态，避免把历史会话已有图片误判为一次新完成
    if (imgGenTrackingConvIdRef.current !== convId) {
      imgGenTrackingConvIdRef.current = convId
      pendingImageGenMessageIdRef.current = null
      generationCompletionBottomIntentRef.current = false
      lastImageGenResultKeyRef.current = ''
    }

    // 1) 记录「正在生成」的 assistant 消息 —— 只有它后续真正落图才算一次完成
    if (imageGenActiveAssistantId) {
      pendingImageGenMessageIdRef.current = imageGenActiveAssistantId
    }

    const pendingId = pendingImageGenMessageIdRef.current
    if (!pendingId) return

    // 2) 仍在生成：不消费结果 key，等完成事件后再统一判定，
    //    避免 attachment 先于 idle 到达时被误判并提前清空 pending
    if (imageGenPhase === 'generating' || imageGenActiveAssistantId) return

    // 3) 图片生成结果 key：所有 generation_output 附件的 (messageId, attachmentId) 组合。
    //    key 变化即代表有图片真正写入消息（异步 reload 后的那一帧）。
    let resultKey = ''
    for (const m of messages) {
      for (const a of m.attachments) {
        if (a.usage === 'generation_output') resultKey += `${m.id}:${a.id};`
      }
    }
    const resultChanged = resultKey !== lastImageGenResultKeyRef.current
    lastImageGenResultKeyRef.current = resultKey

    const pendingMsg = messages.find((m) => m.id === pendingId)

    // 4) 失败/停止收尾：无论有无残留附件，都清理且绝不 arm
    if (pendingMsg && (pendingMsg.status === 'failed' || pendingMsg.status === 'stopped')) {
      pendingImageGenMessageIdRef.current = null
      return
    }

    const hasResult = !!pendingMsg?.attachments.some((a) => a.usage === 'generation_output')
    if (!hasResult) return

    // 5) 落图帧：此刻 pinnedRef / followModeRef 仍是占位骨架世界（swap 前）的状态，
    //    即「完成前用户是否贴底跟随」。仅此情形补一次贴底，其余（在看历史）一律不打扰。
    const wasPinnedToBottom =
      pinnedRef.current &&
      followModeRef.current === 'FOLLOWING' &&
      userScrollIntentUntilRef.current <= performance.now() &&
      !scrollbarDraggingRef.current

    if (resultChanged && wasPinnedToBottom) {
      followModeRef.current = 'FOLLOWING'
      pinnedRef.current = true
      programmaticScrollTargetRef.current = null
      generationCompletionBottomIntentRef.current = true
      generationCompletionDeadlineRef.current = performance.now() + GENERATION_COMPLETION_SETTLE_MS
      setShowScrollToBottom(false)
      scrollToBottom()
    }
    pendingImageGenMessageIdRef.current = null
  }, [activeConversation?.id, imageGenActiveAssistantId, imageGenPhase, messages])

  // 监听用户滚动：区分程序滚动与用户滚动
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const markIntent = () => {
      userScrollIntentUntilRef.current = performance.now() + 250
      // 用户一旦表达滚动意图，立即放弃首次定位意图，绝不把正在看历史的人拉回底部
      initialBottomIntentRef.current = false
      // 同理放弃图片生成完成的补底意图
      generationCompletionBottomIntentRef.current = false
    }
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
      // 任何带用户意图的滚动（含拖动 scrollbar）都放弃首次定位意图
      if (hasRecentIntent || isScrollbarDrag) {
        initialBottomIntentRef.current = false
        generationCompletionBottomIntentRef.current = false
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

      // 首次进入会话：图片 decode 等异步布局增长期间，若用户尚未滚动，
      // 继续贴底；若 scrollHeight 已稳定（本轮无增长）或超时，则结束该意图。
      if (isInitialBottomIntentActive()) {
        if (scrollHeight !== lastObservedScrollHeightRef.current) {
          lastObservedScrollHeightRef.current = scrollHeight
          scrollToBottom()
          setShowScrollToBottom(false)
          return
        }
        // else: 高度未变，交给下方按常规规则更新 pinned/按钮
      }

      // 图片生成完成补底意图：图片 decode / 异步布局增长期间继续贴底，窄分支、超时即止。
      if (isGenerationCompletionBottomIntentActive()) {
        scrollToBottom()
        setShowScrollToBottom(false)
        return
      }

      pinnedRef.current = distanceFromBottom < PINNED_THRESHOLD
      setShowScrollToBottom(distanceFromBottom >= SHOW_BUTTON_THRESHOLD)
    })
    observer.observe(content)

    // 视口高度变化（Composer 因错误提示增高 / 窗口缩放）会压缩消息区可视高度，
    // 但内容高度不变，content 观察器不会触发，导致底部内容被遮挡。
    // 单独观察滚动容器：只要用户处于跟随态且贴底，就重新贴底，保持内容可见。
    const viewportObserver = new ResizeObserver(() => {
      if (isConversationSwitchDiagActive()) return
      if (followModeRef.current === 'FOLLOWING' && pinnedRef.current) {
        scrollToBottom()
        setShowScrollToBottom(false)
      }
    })
    viewportObserver.observe(list)

    return () => {
      observer.disconnect()
      viewportObserver.disconnect()
    }
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

  // 空状态按会话类型区分：图片生成不使用「开始对话」这类聊天语义。
  // 仅当没有任何可展示消息（无用户提问 / 无生成图 / 无输入输出附件）时展示。
  const isImageGeneration = activeConversation?.type === 'image_generation'
  const showEmptyState = messages.length === 0 && !showTrailingBoundary

  return (
    <ScrollContainerContext.Provider value={scrollControl}>
    <div className="message-list-viewport">
    <div className="message-list" ref={listRef} onContextMenu={handleContextMenu}>
      <div ref={contentRef}>
        {showEmptyState ? (
          isImageGeneration ? (
            <div className="messages-empty">
              <div className="messages-empty-icon messages-empty-icon--image">
                <div className="image-empty-picture">
                  <svg className="image-empty-glyph" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <defs>
                      {/* 裁剪框与内部图片 frame 几何一致（略向内收 0.4，避开 stroke 内侧） */}
                      <clipPath id={`${imageClipId}-frame`}>
                        <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="1.6" />
                      </clipPath>
                      <linearGradient id={`${imageClipId}-sweep`} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" className="image-empty-sweep-stop" />
                        <stop offset="50%" className="image-empty-sweep-stop image-empty-sweep-stop--mid" />
                        <stop offset="100%" className="image-empty-sweep-stop" />
                      </linearGradient>
                    </defs>
                    {/* 内部图像内容：太阳 / 山峰 / 扫描高光，全部限制在图片框内 */}
                    <g clipPath={`url(#${imageClipId}-frame)`}>
                      <circle className="image-empty-sun" cx="8.5" cy="8.5" r="1.5" />
                      <path className="image-empty-landscape" d="M21 15l-5-5L5 21" />
                      <rect className="image-empty-scan" x="3.4" y="3.4" width="6.4" height="17.2" fill={`url(#${imageClipId}-sweep)`} />
                    </g>
                    {/* frame stroke 绘制在裁剪内容之上，边缘始终完整 */}
                    <rect className="image-empty-frame" x="3" y="3" width="18" height="18" rx="2" />
                  </svg>
                </div>
                <span className="image-sparkle image-sparkle--lg" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0L14.4 9.6L24 12L14.4 14.4L12 24L9.6 14.4L0 12L9.6 9.6Z" />
                  </svg>
                </span>
                <span className="image-sparkle image-sparkle--sm" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0L14.4 9.6L24 12L14.4 14.4L12 24L9.6 14.4L0 12L9.6 9.6Z" />
                  </svg>
                </span>
              </div>
              <div className="messages-empty-title">开始生成图片</div>
              <div className="messages-empty-hint">在下方描述你想生成的画面</div>
            </div>
          ) : (
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
          )
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