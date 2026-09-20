import { useEffect, useRef } from 'react'
import { useUiStore, type SearchMatch } from '../../stores/uiStore'
import { useConversationStore } from '../../stores/conversationStore'

let isApplying = false
let isSelecting = false

document.addEventListener('mousedown', () => { isSelecting = true })
document.addEventListener('mouseup', () => { isSelecting = false })

function clearHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll('mark.search-highlight')
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
  }
  root.normalize()
}

function highlightText(root: HTMLElement, query: string, matches: SearchMatch[], currentMatchIdx: number, messageId: string): void {
  const lowerQuery = query.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement
      if (!el) return NodeFilter.FILTER_REJECT
      if (el.tagName === 'MARK' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const textNodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text)
  }

  let localIndex = 0

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? ''
    const lower = text.toLowerCase()
    if (!lower.includes(lowerQuery)) continue

    const frag = document.createDocumentFragment()
    let last = 0
    let idx = lower.indexOf(lowerQuery)
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)))
      const mark = document.createElement('mark')
      mark.className = 'search-highlight'

      const firstForMessage = matches.find((m) => m.messageId === messageId)?.globalIndex ?? 0
      const isCurrent = matches[currentMatchIdx]?.messageId === messageId &&
        matches[currentMatchIdx]?.globalIndex === firstForMessage + localIndex

      if (isCurrent) {
        mark.classList.add('search-highlight-current')
      }
      mark.textContent = text.slice(idx, idx + query.length)
      frag.appendChild(mark)
      last = idx + query.length
      localIndex++
      idx = lower.indexOf(lowerQuery, last)
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }
}

function getActivePaneMessageList(): HTMLElement | null {
  // Keep-alive 模式下同时存在多个 .message-list，必须限定到 active pane
  // data-conversation-pane 加在 .message-list-viewport 上，.message-list 是其子元素
  const activeId = useConversationStore.getState().activeConversationId
  if (activeId) {
    // active pane 必须命中；未挂载时返回 null，不回退到任意 .message-list（避免命中 hidden pane）
    return document.querySelector<HTMLElement>(
      `[data-conversation-pane="${activeId}"] .message-list`
    )
  }
  // 非 keep-alive 模式：无 pane id 时取第一个
  return document.querySelector<HTMLElement>('.message-list')
}

function applyHighlights(query: string, matches: SearchMatch[], currentMatchIdx: number, scrollToMatch: boolean): void {
  const container = getActivePaneMessageList()
  if (!container) return

  isApplying = true
  try {
    clearHighlights(container as HTMLElement)

    if (!query) return

    const messageEls = container.querySelectorAll<HTMLElement>('.message-content')
    for (const el of Array.from(messageEls)) {
      const messageEl = el.closest('[data-message-id]') as HTMLElement | null
      const mid = messageEl?.dataset.messageId
      if (!mid) continue
      highlightText(el as HTMLElement, query, matches, currentMatchIdx, mid)
    }

    if (scrollToMatch) {
      const currentMark = container.querySelector('mark.search-highlight-current')
      if (currentMark) {
        currentMark.scrollIntoView({ block: 'center' })
      }
    }
  } finally {
    isApplying = false
  }
}

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
    applyHighlights(searchQuery, searchMatches, currentMatchIndex, scrollToMatch)
  }, [searchQuery, searchMatches, currentMatchIndex])

  // 监听 React 流式渲染导致的 DOM 替换，自动重新应用高亮（不滚动）
  // Keep-alive 下 A→B 后 A DOM 保留，observer 必须随 activeConversationId 切换到新 active pane
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  useEffect(() => {
    const container = getActivePaneMessageList()
    if (!container) return

    let rafId: number | null = null
    let pending = false

    observerRef.current = new MutationObserver(() => {
      if (isApplying || isSelecting) return
      const state = useUiStore.getState()
      if (!state.searchQuery || pending) return
      pending = true
      rafId = requestAnimationFrame(() => {
        pending = false
        applyHighlights(state.searchQuery, state.searchMatches, state.currentMatchIndex, false)
      })
    })
    observerRef.current.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
      if (rafId != null) cancelAnimationFrame(rafId)
      // 清理时只清当前 active pane（与 observe 目标一致）
      const c = getActivePaneMessageList()
      if (c) clearHighlights(c as HTMLElement)
    }
  }, [activeConversationId])
}