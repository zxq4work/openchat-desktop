import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationSummary } from '../../../shared/types/conversation'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'
import { markConversationSwitch } from '../../packages/layoutReadDiag'

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
    // 点击当前已 active 的会话应为 no-op：不重新拉取、不重新 hydrate activeMessages。
    // 否则会在流式期间用 DB 中途落盘的 content 覆盖 live 渲染基线，触发正文重复拼接/抖动。
    // 这是一层 UI 保护；底层 live answer 数据源本身也已做到 hydrate 幂等（见 streamOwnership）。
    if (summary.id === activeConversationId) {
      return
    }
    const t0 = performance.now()
    markConversationSwitch()
    const data = await window.openchat.conversations.get(summary.id)

    if (data) {
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

    if (activeConversationId === summary.id) {
      setActiveConversationId(null)
      setActiveConversation(null)
      setActiveMessages([])
      setActiveSegments([])
    }

    const list = await window.openchat.conversations.list()
    setSummaries(list)
  }

  const isImageGeneration = summary.type === 'image_generation'

  return (
    <div
      className={`conversation-item ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
      onClick={handleClick}
      title={summary.title}
    >
      <div className="conversation-title">
        {isImageGeneration && (
          <span className="conversation-type-icon" title="图片生成会话" aria-label="图片生成会话">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </span>
        )}
        <span className="conversation-title-text">{summary.title}</span>
      </div>
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
