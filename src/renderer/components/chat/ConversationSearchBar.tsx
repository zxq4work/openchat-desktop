import React from 'react'
import { useConversationSearchStore } from '../../stores/conversationSearchStore'

// 当前会话命中导航条（右侧 Chat 顶部）。
// 它不是新的搜索框：只是全局搜索 query 在当前会话内的命中导航。
// 关闭它只隐藏本导航，绝不退出左侧 Search Mode。
export function ConversationSearchBar() {
  const query = useConversationSearchStore((s) => s.query)
  const navBarVisible = useConversationSearchStore((s) => s.navBarVisible)
  const activeMatches = useConversationSearchStore((s) => s.activeMatches)
  const activeMatchIndex = useConversationSearchStore((s) => s.activeMatchIndex)

  if (!navBarVisible || activeMatches.length === 0) return null

  const label = `${activeMatchIndex + 1} / ${activeMatches.length}`

  return (
    <div className="conversation-search-bar">
      <span className="conversation-search-bar-query" title={query}>{query}</span>
      <span className="conversation-search-bar-count">{label}</span>
      <button
        className="conversation-search-bar-btn"
        onClick={() => useConversationSearchStore.getState().prevMatch()}
        title="上一条匹配"
        aria-label="上一条匹配"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        className="conversation-search-bar-btn"
        onClick={() => useConversationSearchStore.getState().nextMatch()}
        title="下一条匹配"
        aria-label="下一条匹配"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button
        className="conversation-search-bar-btn conversation-search-bar-close"
        onClick={() => useConversationSearchStore.getState().closeNavBar()}
        title="关闭命中导航"
        aria-label="关闭命中导航"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}
