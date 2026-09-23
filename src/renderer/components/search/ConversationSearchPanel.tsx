import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useConversationSearchStore } from '../../stores/conversationSearchStore'
import { useConversationStore } from '../../stores/conversationStore'
import { SearchScopeTabs } from './SearchScopeTabs'
import { ConversationSearchResultItem } from './ConversationSearchResultItem'
import { selectConversationById } from '../../packages/selectConversation'
import type { ConversationSearchResult } from '../../../shared/types/search'

const SEARCH_DEBOUNCE_MS = 200
// 首屏结果渲染上限，避免一次渲染大量结果节点。
const MAX_RENDERED_RESULTS = 100

// 全局会话搜索面板（Search Mode 左侧）。挂载后保持常驻，
// 不随 activeConversationId 变化 remount —— 搜索上下文（query/scope/results/滚动位置）持续存在。
export function ConversationSearchPanel() {
  const query = useConversationSearchStore((s) => s.query)
  const scope = useConversationSearchStore((s) => s.scope)
  const loading = useConversationSearchStore((s) => s.loading)
  const error = useConversationSearchStore((s) => s.error)
  const results = useConversationSearchStore((s) => s.results)
  const selectedConversationId = useConversationSearchStore((s) => s.selectedConversationId)

  const activeConversationId = useConversationStore((s) => s.activeConversationId)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 请求竞态守卫：只接受最新一次搜索的结果
  const searchSeqRef = useRef(0)
  // 键盘导航用：当前停留结果在列表中的索引。
  // 初始 / 每次搜索完成后均为 -1（无任何行被高亮）——
  // 只有用户显式按 ArrowUp / ArrowDown 才会移动到某一行。
  const [keyboardIndex, setKeyboardIndex] = useState(-1)

  // 进入面板自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 防抖执行搜索：query / scope 变化 200ms 后查询数据库。
  // query 为空不访问数据库。
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      useConversationSearchStore.getState().setLoading(false)
      useConversationSearchStore.getState().setSearchResults([])
      setKeyboardIndex(-1)
      return
    }
    useConversationSearchStore.getState().setLoading(true)
    // 新一次搜索：滚动归零（点击结果不触发本 effect，故结果列表滚动位置得以保持）
    useConversationSearchStore.getState().setResultScrollTop(0)
    const seq = ++searchSeqRef.current
    const timer = setTimeout(() => {
      window.openchat.conversations.search(trimmed, scope).then((res: ConversationSearchResult[]) => {
        // 旧请求后返回不覆盖新请求结果
        if (seq !== searchSeqRef.current) return
        // 查询期间用户又改了 query/scope → 丢弃
        const state = useConversationSearchStore.getState()
        if (state.query.trim() !== trimmed || state.scope !== scope) return
        useConversationSearchStore.getState().setSearchResults(res)
        // 搜索完成后不默认高亮任何一行（-1），等待用户显式键盘导航或点击
        setKeyboardIndex(-1)
      }).catch(() => {
        if (seq !== searchSeqRef.current) return
        useConversationSearchStore.getState().setSearchResults([], '搜索失败，请重试')
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, scope])

  // 恢复结果列表滚动位置（切会话导致的父级重渲染不应把滚动归零）
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = useConversationSearchStore.getState().resultScrollTop
  }, [results])

  // 键盘导航：停留行滚入视野（不影响记录的 resultScrollTop）
  useEffect(() => {
    if (keyboardIndex < 0) return
    const el = listRef.current?.querySelectorAll('.search-result-item')[keyboardIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [keyboardIndex])

  const handleSelect = useCallback(async (result: ConversationSearchResult) => {
    const store = useConversationSearchStore.getState()
    // 只有真实点击 / 回车才写入「用户选中」，并同步键盘停留行到该条
    store.selectSearchResult(result.conversationId)
    setKeyboardIndex(results.findIndex((r) => r.conversationId === result.conversationId))
    // 复用现有会话打开逻辑（只读，不修改 updatedAt）
    const opened = await selectConversationById(result.conversationId)
    if (!opened) return

    // 有正文匹配：查询该会话全部匹配消息并定位到 bestMatch。
    // 仅标题命中（无正文匹配）：正常打开，不强制滚动。
    if (!result.bestMatch) {
      store.closeNavBar()
      return
    }
    const matches = await window.openchat.conversations.searchMatches(result.conversationId, store.query.trim())
    const s = useConversationSearchStore.getState()
    s.setActiveMatches(matches, result.conversationId)
    // 冻结此刻的搜索词：后续关键词高亮只认这个快照，不跟随左侧实时输入框变化。
    // 必须在 setActiveMatches（会话已激活）之后写入，否则会被会话切换流程清掉。
    s.setHighlightQuery(store.query.trim())
    const idx = matches.findIndex((m) => m.messageId === result.bestMatch!.messageId)
    if (idx >= 0) {
      s.jumpToMatch(idx)
    }
  }, [results])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const list = results
    if (e.key === 'Escape') {
      // 清空输入，不退出 Search Mode
      e.preventDefault()
      if (query) useConversationSearchStore.getState().setSearchQuery('')
      else inputRef.current?.blur()
      return
    }
    if (list.length === 0) return
    if (e.key === 'ArrowDown') {
      // 首次按下从 -1 → 0，之后逐条下移
      e.preventDefault()
      setKeyboardIndex((i) => Math.min(list.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setKeyboardIndex((i) => (i < 0 ? list.length - 1 : Math.max(0, i - 1)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // 未用键盘停留任何行时（-1），回车不打开任何结果
      const target = keyboardIndex >= 0 ? list[keyboardIndex] : undefined
      if (target) void handleSelect(target)
    }
  }, [results, query, keyboardIndex, handleSelect])

  const visibleResults = results.slice(0, MAX_RENDERED_RESULTS)
  const trimmedQuery = query.trim()
  const showEmptyState = !trimmedQuery
  const showNoResults = !!trimmedQuery && !loading && !error && results.length === 0

  return (
    <div className="conversation-search-panel">
      <div className="search-panel-header">
        <button
          className="search-panel-back"
          onClick={() => useConversationSearchStore.getState().exitSearchMode()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          搜索会话
        </button>
      </div>

      <div className="search-panel-input-wrap">
        <span className="search-panel-input-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="search-panel-input"
          type="text"
          placeholder="搜索所有会话…"
          value={query}
          onChange={(e) => useConversationSearchStore.getState().setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button
            className="search-panel-clear"
            onClick={() => { useConversationSearchStore.getState().setSearchQuery(''); inputRef.current?.focus() }}
            title="清空"
            aria-label="清空"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div className="search-panel-scope">
        <SearchScopeTabs
          scope={scope}
          onChange={(s) => useConversationSearchStore.getState().setSearchScope(s)}
        />
      </div>

      {error && <div className="search-panel-error">{error}</div>}

      {trimmedQuery && !error && (
        <div className="search-panel-status">
          {loading ? '搜索中…' : `找到 ${results.length} 个相关会话`}
        </div>
      )}

      <div
        className="search-panel-results"
        ref={listRef}
        onScroll={(e) => useConversationSearchStore.getState().setResultScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {showEmptyState && (
          <div className="search-panel-empty">
            <div className="search-panel-empty-title">搜索你的所有会话</div>
            <div className="search-panel-empty-hint">支持按标题或聊天内容搜索</div>
          </div>
        )}

        {showNoResults && (
          <div className="search-panel-empty">
            <div className="search-panel-empty-title">没有找到相关会话</div>
            <div className="search-panel-empty-hint">尝试更换关键词，或切换搜索范围</div>
            {scope === 'title' && (
              <button
                className="search-panel-scope-action"
                onClick={() => useConversationSearchStore.getState().setSearchScope('all')}
              >
                搜索聊天内容
              </button>
            )}
          </div>
        )}

        {visibleResults.map((r, i) => (
          <ConversationSearchResultItem
            key={r.conversationId}
            result={r}
            query={trimmedQuery}
            active={r.conversationId === activeConversationId}
            selected={r.conversationId === selectedConversationId}
            keyboardActive={i === keyboardIndex}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  )
}
