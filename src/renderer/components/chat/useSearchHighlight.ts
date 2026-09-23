import { useEffect, useRef } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { applyHighlights, clearHighlights, isHighlightBusy } from '../../packages/messageHighlight'

// 会话内文字搜索（Cmd/Ctrl+F）的高亮驱动。
// 底层 DOM 高亮算法已抽到 packages/messageHighlight.ts 与全局搜索共用；
// 这里只负责把 uiStore 的搜索状态接给引擎，mode 固定为 'local'（黄 + 橙 current）。
export function useSearchHighlight(): void {
  const searchQuery = useUiStore((s) => s.searchQuery)
  const searchMatches = useUiStore((s) => s.searchMatches)
  const currentMatchIndex = useUiStore((s) => s.currentMatchIndex)
  const observerRef = useRef<MutationObserver | null>(null)
  const prevMatchIndexRef = useRef(-1)

  // 搜索状态变化时重新高亮（matchIndex 变化时滚动到目标）
  useEffect(() => {
    const scrollToMatch = currentMatchIndex !== prevMatchIndexRef.current
    prevMatchIndexRef.current = currentMatchIndex
    const container = document.querySelector('.message-list')
    if (!container) return
    applyHighlights(container as HTMLElement, {
      query: searchQuery,
      matches: searchMatches,
      currentMatchIndex,
      mode: 'local',
      scrollToMatch,
    })
  }, [searchQuery, searchMatches, currentMatchIndex])

  // 监听 React 流式渲染导致的 DOM 替换，自动重新应用高亮（不滚动）
  useEffect(() => {
    const container = document.querySelector('.message-list')
    if (!container) return

    let rafId: number | null = null
    let pending = false

    observerRef.current = new MutationObserver(() => {
      if (isHighlightBusy()) return
      const state = useUiStore.getState()
      if (!state.searchQuery || pending) return
      pending = true
      rafId = requestAnimationFrame(() => {
        pending = false
        const el = document.querySelector('.message-list')
        if (!el) return
        applyHighlights(el as HTMLElement, {
          query: state.searchQuery,
          matches: state.searchMatches,
          currentMatchIndex: state.currentMatchIndex,
          mode: 'local',
          scrollToMatch: false,
        })
      })
    })
    observerRef.current.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    return () => {
      observerRef.current?.disconnect()
      if (rafId != null) cancelAnimationFrame(rafId)
      const c = document.querySelector('.message-list')
      if (c) clearHighlights(c as HTMLElement)
    }
  }, [])
}
