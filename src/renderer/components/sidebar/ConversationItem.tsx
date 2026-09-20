import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationSummary } from '../../../shared/types/conversation'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'
import { markConversationSwitch, switchTimingBegin, switchTimingMark } from '../../packages/layoutReadDiag'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import {
  DIAG_ENABLE_CONVERSATION_KEEP_ALIVE,
  keepAliveIsCached,
  keepAliveGetPreviousEntry,
  keepAliveRotateIn,
  keepAliveEvictDeleted,
  type PaneEntry,
} from '../../packages/conversationKeepAlive'

interface Props {
  summary: ConversationSummary
  active: boolean
}

export function ConversationItem({ summary, active }: Props) {
  const setSummaries = useConversationStore((s) => s.setSummaries)
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const setActiveMessages = useConversationStore((s) => s.setActiveMessages)
  const setActiveSegments = useConversationStore((s) => s.setActiveSegments)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const setConversationSettingsOpen = useUiStore((s) => s.setConversationSettingsOpen)
  const setConversationSettingsTargetId = useUiStore((s) => s.setConversationSettingsTargetId)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!menuOpen) return
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    // 侧栏滚动时按钮位置改变，fixed 菜单会错位，关闭菜单
    const handleScroll = (e: Event) => {
      if (menuBtnRef.current && e.target instanceof Node && e.target.contains(menuBtnRef.current)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [menuOpen])

  const handleClick = async () => {
    const t0 = performance.now()
    markConversationSwitch()

    // Keep-alive：检查目标会话是否在 previous 缓存中
    if (DIAG_ENABLE_CONVERSATION_KEEP_ALIVE && keepAliveIsCached(summary.id)) {
      const cached = keepAliveGetPreviousEntry()!
      console.log('[keepalive] cache hit id=%s', summary.id.slice(0, 8))
      // 分阶段埋点：起点 = cache hit 命中
      switchTimingBegin(summary.id, t0)

      // 旧 current（现在 active 的会话）的数据从 store 取最新值，降为 previous
      const prevId = useConversationStore.getState().activeConversationId
      const prevConv = useConversationStore.getState().activeConversation
      const prevMsgs = useConversationStore.getState().activeMessages
      const prevSegs = useConversationStore.getState().activeSegments
      const streamConvId = useChatStreamStore.getState().streamingConversationId
      const prevSettled = prevId != null && prevId !== streamConvId

      const prevSnapshot: PaneEntry | null = (prevId && prevConv)
        ? {
            conversationId: prevId,
            conversation: prevConv,
            messages: prevMsgs,
            segments: prevSegs,
          }
        : null

      // rotateIn：旧 current(B) 降为 previous，旧 previous(A) evict，新 current=A
      // 注意：cached(A) 的数据来自 previous snapshot，但 A 成为 current 后从 store 读
      // 所以这里把 cached 数据写回 store
      keepAliveRotateIn(summary.id, prevSettled, prevSnapshot)

      // DOM identity 验证：切换前抓 A 的 message DOM 引用，切换后确认仍是同一实例
      const paneBefore = document.querySelector<HTMLElement>(
        `[data-conversation-pane="${summary.id}"] .message-list [data-message-id]`
      )

      // 原子写入 store：用缓存数据，不触发 IPC
      useConversationStore.getState().activateConversation(
        summary.id, cached.conversation, cached.messages, cached.segments
      )
      // 分阶段埋点：store 写入完成（此后 await React commit）
      switchTimingMark(summary.id, 'store-write')

      // 延迟记录
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const t1 = performance.now()
          const paneAfter = document.querySelector<HTMLElement>(
            `[data-conversation-pane="${summary.id}"] .message-list [data-message-id]`
          )
          if (paneBefore && paneAfter) {
            console.log('[keepalive] dom-identity id=%s same=%s',
              summary.id.slice(0, 8), paneBefore === paneAfter)
          }
          console.log('[perf] conversation-switch|id=%s msgs=%d total=%dms (cached)',
            summary.id.slice(0, 8), cached.messages.length, Math.round(t1 - t0))
          // 分阶段埋点：finish 与 switchTimingEnd 交由 MessageList restore 完成时打印
          // （restore 在双 rAF 后执行；此处 rAF 注册更早，若在此 end 会早于 restore-end）
        })
      })
      return
    }

    const data = await window.openchat.conversations.get(summary.id)

    if (data) {
      // Keep-alive：轮换缓存
      if (DIAG_ENABLE_CONVERSATION_KEEP_ALIVE) {
        const prevId = useConversationStore.getState().activeConversationId
        const prevConv = useConversationStore.getState().activeConversation
        const prevMsgs = useConversationStore.getState().activeMessages
        const prevSegs = useConversationStore.getState().activeSegments
        const streamConvId = useChatStreamStore.getState().streamingConversationId
        const prevSettled = prevId != null && prevId !== streamConvId

        const prevSnapshot: PaneEntry | null = (prevId && prevConv)
          ? {
              conversationId: prevId,
              conversation: prevConv,
              messages: prevMsgs,
              segments: prevSegs,
            }
          : null

        keepAliveRotateIn(summary.id, prevSettled, prevSnapshot)
      }

      // 原子写入：一次 set 同时更新 id/conversation/messages/segments，消除中间态
      useConversationStore.getState().activateConversation(
        summary.id, data.conversation, data.messages, data.segments
      )
      // 延迟记录：等待 React 渲染完成
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const t1 = performance.now()
          console.log('[perf] conversation-switch|id=%s msgs=%d total=%dms',
            summary.id.slice(0, 8), data.messages.length, Math.round(t1 - t0))
        })
      })
    }
  }

  const handleMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen((prev) => {
      if (prev) return false
      const btn = menuBtnRef.current
      if (!btn) return true
      const rect = btn.getBoundingClientRect()
      const above = rect.top > window.innerHeight - rect.bottom
      setMenuStyle({
        left: rect.right - 130,
        ...(above
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      })
      return true
    })
  }, [])

  const handleOpenSettings = (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    setConversationSettingsTargetId(summary.id)
    setConversationSettingsOpen(true)
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    await window.openchat.conversations.remove(summary.id)

    // Keep-alive：清理缓存中的对应 pane
    if (DIAG_ENABLE_CONVERSATION_KEEP_ALIVE) {
      keepAliveEvictDeleted(summary.id)
    }

    if (activeConversationId === summary.id) {
      setActiveConversationId(null)
      setActiveConversation(null)
      setActiveMessages([])
      setActiveSegments([])
    }

    const list = await window.openchat.conversations.list()
    setSummaries(list)
  }

  return (
    <div
      className={`conversation-item ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
      onClick={handleClick}
      title={summary.title}
    >
      <div className="conversation-title">{summary.title}</div>
      <div className="conversation-preview">{summary.preview}</div>
      <div className="conversation-menu-wrapper" ref={menuRef}>
        <button
          ref={menuBtnRef}
          className="conversation-menu-btn"
          onClick={handleMenu}
          title="更多操作"
        >
          <svg width="4" height="16" viewBox="0 0 4 16" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="3" r="1.25" />
            <circle cx="2" cy="8" r="1.25" />
            <circle cx="2" cy="13" r="1.25" />
          </svg>
        </button>
        {menuOpen &&
          createPortal(
            <div className="conversation-dropdown" ref={dropdownRef} style={menuStyle}>
              <button className="conversation-dropdown-item" onClick={handleOpenSettings}>
                设置
              </button>
              <div className="conversation-dropdown-divider" />
              <button className="conversation-dropdown-item conversation-dropdown-item-danger" onClick={handleDelete}>
                删除
              </button>
            </div>,
            document.body
          )}
      </div>
    </div>
  )
}
