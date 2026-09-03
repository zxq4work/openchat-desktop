import React, { useState, useRef, useEffect } from 'react'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
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

  const handleMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen((prev) => !prev)
  }

  const handleOpenSettings = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setActiveConversationId(summary.id)
    const data = await window.openchat.conversations.get(summary.id)
    if (data) {
      setActiveConversation(data.conversation)
      setActiveMessages(data.messages)
      setActiveSegments(data.segments)
    }
    setConversationSettingsOpen(true)
    setMenuOpen(false)
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
          className="conversation-menu-btn"
          onClick={handleMenu}
          title="更多操作"
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="conversation-dropdown">
            <button className="conversation-dropdown-item" onClick={handleOpenSettings}>
              设置
            </button>
            <div className="conversation-dropdown-divider" />
            <button className="conversation-dropdown-item conversation-dropdown-item-danger" onClick={handleDelete}>
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
