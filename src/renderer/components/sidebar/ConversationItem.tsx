import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationSummary } from '../../../shared/types/conversation'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'

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
    setActiveConversationId(summary.id)
    const data = await window.openchat.conversations.get(summary.id)
    if (data) {
      setActiveConversation(data.conversation)
      setActiveMessages(data.messages)
      setActiveSegments(data.segments)
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
