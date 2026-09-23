import { useEffect, useRef } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useConversationSearchStore } from '../../stores/conversationSearchStore'
import {
  applyHighlights,
  clearHighlights,
  isHighlightBusy,
  selectGlobalHighlightTarget,
  type GlobalHighlightTarget,
} from '../../packages/messageHighlight'

function readTarget(): GlobalHighlightTarget | null {
  const s = useConversationSearchStore.getState()
  return selectGlobalHighlightTarget({
    highlightQuery: s.highlightQuery,
    navConversationId: s.navConversationId,
    activeConversationId: useConversationStore.getState().activeConversationId,
    activeMatches: s.activeMatches,
    activeMatchIndex: s.activeMatchIndex,
    searchVisible: useUiStore.getState().searchVisible,
    locateRequestId: s.locateRequestId,
  })
}

// 全局会话搜索定位后的关键词高亮驱动。
// 复用 packages/messageHighlight.ts 的同一套 DOM 引擎，mode 固定为 'global'
// （目标 Message 内所有 occurrence 一律普通黄色，不产生橙色 current）。
//
// 关键点：
// - 使用「点选时冻结的 query 快照」highlightQuery，而不是左侧实时输入框，
//   避免每敲一个字符就重算整列高亮。
// - 只高亮当前 activeMatch 指向的那条 Message（onlyMessageId）。
// - 返回 alignOnce()：把「目标 Message 内第一个命中 mark」作为最终滚动锚点。
//   它由 engine 在 apply 时同步创建并返回，因此不需要任何 setTimeout 轮询。
//   幂等：同一次跳转令牌（alignTick）只对齐一次，且真正滚动只发生在
//   MessageList 消费新的 pendingLocate 时（用户显式导航），MutationObserver
//   的重应用一律不滚动。
export function useGlobalSearchHighlight(): { alignOnce: () => boolean } {
  const highlightQuery = useConversationSearchStore((s) => s.highlightQuery)
  const navConversationId = useConversationSearchStore((s) => s.navConversationId)
  const activeMatches = useConversationSearchStore((s) => s.activeMatches)
  const activeMatchIndex = useConversationSearchStore((s) => s.activeMatchIndex)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const searchVisible = useUiStore((s) => s.searchVisible)

  const observerRef = useRef<MutationObserver | null>(null)
  // 最近一次已完成对齐的跳转令牌；相同即视为本次跳转已处理，避免重复滚动。
  const lastAlignedTickRef = useRef(-1)

  // 幂等对齐：以目标 Message 内第一个命中 mark 为锚点滚动。
  // 返回是否「本次跳转已对齐（含此前已对齐）」——供 MessageList 决定是否兜底滚 Message 根节点。
  const alignOnce = (): boolean => {
    const target = readTarget()
    if (!target) return false
    if (target.alignTick === lastAlignedTickRef.current) return true
    lastAlignedTickRef.current = target.alignTick
    const container = document.querySelector('.message-list')
    if (!container) return false
    // engine 内部创建 mark 后立即以首个 mark 调用 scrollIntoView({ block:'center', inline:'nearest' })。
    const first = applyHighlights(container as HTMLElement, {
      query: target.query,
      matches: [],
      currentMatchIndex: -1,
      mode: 'global',
      onlyMessageId: target.messageId,
      scrollToMatch: false,
      alignToFirst: true,
    })
    return first != null
  }

  // 状态变化 → 重新应用到目标 Message，或清除
  useEffect(() => {
    const container = document.querySelector('.message-list')
    if (!container) return
    const target = selectGlobalHighlightTarget({
      highlightQuery,
      navConversationId,
      activeConversationId,
      activeMatches,
      activeMatchIndex,
      searchVisible,
      locateRequestId: useConversationSearchStore.getState().locateRequestId,
    })
    if (!target) {
      clearHighlights(container as HTMLElement)
      return
    }
    applyHighlights(container as HTMLElement, {
      query: target.query,
      matches: [],
      currentMatchIndex: -1,
      mode: 'global',
      onlyMessageId: target.messageId,
      scrollToMatch: false,
    })
  }, [highlightQuery, navConversationId, activeMatches, activeMatchIndex, activeConversationId, searchVisible])

  // React 流式渲染会替换正文 DOM、冲掉 mark —— 监听变化并按需重应用。
  // 仅当目标 Message 的 mark 确实丢失时才重应用，避免与自身写入互相触发形成循环。
  useEffect(() => {
    const container = document.querySelector('.message-list')
    if (!container) return

    let rafId: number | null = null
    let pending = false

    observerRef.current = new MutationObserver(() => {
      if (isHighlightBusy() || pending) return
      const target = readTarget()
      // target 为空时不做任何清除：清除只由上面的状态 effect 负责，
      // 否则会在 Ctrl+F 打开（global 让位）时误清掉本地搜索的高亮。
      if (!target) return
      const applied = document.querySelector(
        `[data-message-id="${target.messageId}"] mark.search-highlight`
      )
      if (applied) return
      pending = true
      rafId = requestAnimationFrame(() => {
        pending = false
        if (isHighlightBusy()) return
        const el = document.querySelector('.message-list')
        const t = readTarget()
        if (!el || !t) return
        // 被动补偿：React 重绘 / streaming 导致的 mark 丢失，一律不滚动（alignToFirst 缺省 false），
        // 否则会把正在阅读的用户反复拽回关键词处。滚动只由 alignOnce 承担。
        applyHighlights(el as HTMLElement, {
          query: t.query,
          matches: [],
          currentMatchIndex: -1,
          mode: 'global',
          onlyMessageId: t.messageId,
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

  return { alignOnce }
}
