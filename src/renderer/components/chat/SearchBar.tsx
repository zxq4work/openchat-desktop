import React, { useEffect, useRef, useCallback } from 'react'
import { useUiStore, type SearchMatch } from '../../stores/uiStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useSearchHighlight } from './useSearchHighlight'

export function SearchBar() {
  const searchQuery = useUiStore((s) => s.searchQuery)
  const searchMatches = useUiStore((s) => s.searchMatches)
  const currentMatchIndex = useUiStore((s) => s.currentMatchIndex)
  const setSearchQuery = useUiStore((s) => s.setSearchQuery)
  const setSearchMatches = useUiStore((s) => s.setSearchMatches)
  const closeSearch = useUiStore((s) => s.closeSearch)
  const goToNextMatch = useUiStore((s) => s.goToNextMatch)
  const goToPrevMatch = useUiStore((s) => s.goToPrevMatch)

  const activeMessages = useConversationStore((s) => s.activeMessages)
  const inputRef = useRef<HTMLInputElement>(null)

  // 触发 DOM 高亮
  useSearchHighlight()

  useEffect(() => {
    // 延迟确保 DOM 渲染完成后再聚焦
    const timer = setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  const computeMatches = useCallback((query: string) => {
    if (!query) {
      setSearchMatches([])
      return
    }
    const matches: SearchMatch[] = []
    const lowerQuery = query.toLowerCase()
    let globalIndex = 0

    for (const msg of activeMessages) {
      const content = msg.content
      if (!content) continue

      let searchStart = 0
      const lowerContent = content.toLowerCase()

      while (searchStart < content.length) {
        const idx = lowerContent.indexOf(lowerQuery, searchStart)
        if (idx === -1) break

        matches.push({
          messageId: msg.id,
          globalIndex: globalIndex++,
          start: idx,
          end: idx + query.length,
        })
        searchStart = idx + 1
      }
    }
    setSearchMatches(matches)
  }, [activeMessages, setSearchMatches])

  useEffect(() => {
    computeMatches(searchQuery)
  }, [searchQuery, activeMessages, computeMatches])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        goToPrevMatch()
      } else {
        goToNextMatch()
      }
    }
  }

  const matchLabel = searchQuery
    ? searchMatches.length > 0
      ? `${currentMatchIndex + 1}/${searchMatches.length}`
      : '0/0'
    : ''

  return (
    <div className="search-bar">
      <div className="search-bar-inner">
        <input
          ref={inputRef}
          className="search-bar-input"
          type="text"
          placeholder="查找..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="search-bar-count">{matchLabel}</span>
        <button
          className="search-bar-btn"
          onClick={goToPrevMatch}
          disabled={searchMatches.length === 0}
          title="上一个 (Shift+Enter)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
        <button
          className="search-bar-btn"
          onClick={goToNextMatch}
          disabled={searchMatches.length === 0}
          title="下一个 (Enter)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <button
          className="search-bar-btn search-bar-close"
          onClick={closeSearch}
          title="关闭 (Esc)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  )
}