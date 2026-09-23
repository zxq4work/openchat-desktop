import type { SearchMatch } from '../stores/uiStore'

// 消息关键词高亮的共享 DOM 引擎。
// 原本只有「会话内文字搜索」(Cmd/Ctrl+F) 使用；现在全局会话搜索也复用同一份实现，
// 保证两种搜索看到的关键词高亮视觉与匹配语义完全一致。
//
// 两种 mode：
//   - 'local'  —— 原会话内搜索：普通命中黄色，当前 occurrence 橙色（occurrence 级导航）。
//   - 'global' —— 全局会话搜索：目标 Message 内所有 occurrence 一律普通黄色，
//                 不产生橙色 current（全局搜索的导航粒度是「匹配 Message」，不是 occurrence）。
export type HighlightMode = 'local' | 'global'

export interface ApplyHighlightOptions {
  query: string
  matches: SearchMatch[]
  currentMatchIndex: number
  mode: HighlightMode
  // 仅 mode==='global' 时生效：只高亮该 message，其余消息不高亮（全局搜索的聚焦语义）。
  onlyMessageId?: string
  // 是否滚动到当前命中（全局搜索由 MessageList 的 locate 负责滚动，故传 false）。
  scrollToMatch?: boolean
  // 仅 mode==='global' 使用：apply 完成后立即以「目标 Message 内第一个命中 mark」为锚点，
  // 执行 scrollIntoView({ block:'center', inline:'nearest' }) 并返回是否真的滚动了。
  // 只在用户显式触发一次定位时为 true（幂等），MutationObserver 的重应用一律 false，
  // 否则 React 重绘 / streaming 增量会让页面被反复拽回关键词处。
  alignToFirst?: boolean
}

let isApplying = false
let isSelecting = false
let selectionTrackingInstalled = false

// 选区跟踪：用户在拖选文字时不重应用高亮，避免把选区内的 mark 拆掉。
function ensureSelectionTracking(): void {
  if (selectionTrackingInstalled) return
  selectionTrackingInstalled = true
  document.addEventListener('mousedown', () => { isSelecting = true })
  document.addEventListener('mouseup', () => { isSelecting = false })
}

// 供 MutationObserver 回调判断是否应跳过本次响应（自身改动 / 正在选取）。
export function isHighlightBusy(): boolean {
  return isApplying || isSelecting
}

export function clearHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll('mark.search-highlight')
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
  }
  root.normalize()
}

function highlightText(root: HTMLElement, query: string, matches: SearchMatch[], currentMatchIdx: number, messageId: string, mode: HighlightMode): HTMLElement[] {
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
  // 按 DOM 顺序收集本次创建的 mark —— 第一个即目标 Message 内第一个命中。
  const created: HTMLElement[] = []

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

      // 只有 local 模式才有「当前 occurrence」概念；global 模式一律普通黄。
      if (mode === 'local') {
        const firstForMessage = matches.find((m) => m.messageId === messageId)?.globalIndex ?? 0
        const isCurrent = matches[currentMatchIdx]?.messageId === messageId &&
          matches[currentMatchIdx]?.globalIndex === firstForMessage + localIndex

        if (isCurrent) {
          mark.classList.add('search-highlight-current')
        }
      }
      mark.textContent = text.slice(idx, idx + query.length)
      frag.appendChild(mark)
      created.push(mark)
      last = idx + query.length
      localIndex++
      idx = lower.indexOf(lowerQuery, last)
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }

  return created
}

export function applyHighlights(root: HTMLElement, opts: ApplyHighlightOptions): HTMLElement | null {
  ensureSelectionTracking()

  // 目标 Message 内第一个命中 mark：既是返回值，也是 global 对齐锚点。
  let firstHighlight: HTMLElement | null = null

  isApplying = true
  try {
    clearHighlights(root)

    if (!opts.query) return null

    const messageEls = root.querySelectorAll<HTMLElement>('.message-content')
    for (const el of Array.from(messageEls)) {
      const messageEl = el.closest('[data-message-id]') as HTMLElement | null
      const mid = messageEl?.dataset.messageId
      if (!mid) continue
      // 全局搜索只高亮目标消息；会话内搜索（local）不加限制，与原行为一致。
      if (opts.onlyMessageId && mid !== opts.onlyMessageId) continue
      const created = highlightText(el as HTMLElement, opts.query, opts.matches, opts.currentMatchIndex, mid, opts.mode)
      // messageEls 按 DOM 顺序遍历，第一个非空 created[0] 即整条目标消息内的首个命中。
      if (!firstHighlight && created.length > 0) firstHighlight = created[0]
    }

    if (opts.scrollToMatch) {
      const currentMark = root.querySelector('mark.search-highlight-current')
      if (currentMark) {
        currentMark.scrollIntoView({ block: 'center' })
      }
    }

    // 显式定位：以首个命中为最终滚动锚点。仅当调用方明确要求（幂等触发）时才滚动。
    if (opts.alignToFirst && firstHighlight) {
      firstHighlight.scrollIntoView({ block: 'center', inline: 'nearest' })
    }
  } finally {
    isApplying = false
  }

  return firstHighlight
}

export interface GlobalHighlightTarget {
  query: string
  messageId: string
  // 触发本次定位的跳转令牌：由 conversationSearchStore 的 locateRequestId 归一而来。
  // 消费方（MessageList）用它判断「这是不是一次新的用户导航」，从而只对齐一次。
  alignTick: number
}

// 全局搜索是否应高亮、以及目标 message。纯策略（无 DOM 依赖），便于单测。
// 任一条件不满足即返回 null（调用方据此清除高亮）。
export function selectGlobalHighlightTarget(input: {
  highlightQuery: string
  navConversationId: string | null
  activeConversationId: string | null
  activeMatches: readonly { messageId: string }[]
  activeMatchIndex: number
  searchVisible: boolean
  // 触发本次定位的跳转令牌（store 的 locateRequestId），随每次显式导航递增。
  locateRequestId: number
}): GlobalHighlightTarget | null {
  const query = input.highlightQuery.trim()
  if (!query) return null
  // Cmd/Ctrl+F 打开时，本地会话内搜索拥有高亮权，全局高亮让位，
  // 避免两套引擎争用同一层 mark。
  if (input.searchVisible) return null
  // 尚未建立命中导航，或当前会话不是导航所属会话 → 不高亮（防止切会话后旧高亮残留）。
  if (!input.navConversationId || input.navConversationId !== input.activeConversationId) return null
  const target = input.activeMatches[input.activeMatchIndex]
  if (!target) return null
  return { query, messageId: target.messageId, alignTick: input.locateRequestId }
}
