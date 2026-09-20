/**
 * Conversation Keep-Alive 诊断原型
 *
 * 目标：验证「保留 React subtree 不 unmount」后，复杂历史会话 B → A 是否稳定 <100ms。
 *
 * 限制（prototype，不是正式架构）：
 *   - 最多同时保留 2 个 pane：current + previous
 *   - 仅缓存 settled 会话（streaming 会话不进缓存）
 *   - 无 LRU、无预加载、无虚拟列表
 *
 * 设计原则：
 *   current 不需要单独缓存——它的数据总是从 store 实时读取。
 *   只有 previous（hidden pane）需要 snapshot，因为 store 已指向 current。
 *
 * 日志：
 *   [keepalive] pane mount id=...
 *   [keepalive] pane hide id=...
 *   [keepalive] pane show id=...
 *   [keepalive] pane unmount id=...
 *   [keepalive] messagelist mount id=...
 *   [keepalive] messagelist unmount id=...
 *   [keepalive] cache hit id=...
 *   [keepalive] cache evict id=...
 */

import type { Conversation, ContextSegment, Message } from '@shared/types/conversation'

// 临时诊断 flag：true 启用 keep-alive；false 完全回退到原始单 pane 路径
export const DIAG_ENABLE_CONVERSATION_KEEP_ALIVE = true

// 临时诊断 flag：true 启用 pane rendering isolation 实验（contain + content-visibility）
// 目的：验证 CSS 隔离能否降低切换时大 DOM subtree 的 layout cost（paneVisible->raf1 200~270ms）。
// false 时完全回退到当前基线（仅 visibility 切换）。
// 保留现有 visibility 逻辑，不删除、不引入 display:none。
export const DIAG_PANE_RENDERING_ISOLATION = true

export interface PaneEntry {
  conversationId: string
  conversation: Conversation
  messages: Message[]
  segments: ContextSegment[]
}

// 只有 previous 需要 snapshot（current 的数据从 store 实时读取）
let previousEntry: PaneEntry | null = null

// 已挂载的 pane 集合（用于判断 mount/show/unmount）
const mountedPaneIds = new Set<string>()

// 当前 current pane 的 id（跟随 store，由 rotateIn 时设置）
let currentPaneId: string | null = null

export function keepAliveGetCurrentPaneId(): string | null {
  return currentPaneId
}

export function keepAliveGetPreviousPaneId(): string | null {
  return previousEntry?.conversationId ?? null
}

/**
 * 查询会话是否在缓存中（命中即跳过 conversations.get）。
 */
export function keepAlivePeek(id: string): PaneEntry | null {
  if (currentPaneId === id) {
    // current pane 在缓存中——但数据需要从 store 读取
    // 返回一个标记让调用方知道这是 current pane 命中
    // 实际数据从 store 取，这里返回 null 让调用方走 current-pane 命中路径
    return null  // current 不走 snapshot 路径
  }
  if (previousEntry?.conversationId === id) return previousEntry
  return null
}

/**
 * 切换到新会话前的轮换：
 *   - 旧 current 降为 previous（若可缓存：settled 且非 streaming）—— 数据从 store 取最新值
 *   - 旧 previous evict
 *   - 新会话作为 current
 */
export function keepAliveRotateIn(
  nextId: string,
  prevSettled: boolean,
  prevSnapshot: PaneEntry | null,
): void {
  const oldPrevious = previousEntry

  // 旧 previous 一定 evict
  if (oldPrevious) {
    console.log('[keepalive] cache evict id=%s', oldPrevious.conversationId.slice(0, 8))
  }

  // 旧 current 降为 previous（仅当 settled + 有 snapshot）
  if (prevSettled && prevSnapshot) {
    previousEntry = prevSnapshot
  } else {
    previousEntry = null
  }

  currentPaneId = nextId

  // 通知 ChatView：current/previous 之外的所有已挂载 pane 需要真正 unmount
  const keepIds = new Set<string>()
  if (currentPaneId) keepIds.add(currentPaneId)
  if (previousEntry) keepIds.add(previousEntry.conversationId)
  for (const id of Array.from(mountedPaneIds)) {
    if (!keepIds.has(id)) {
      mountedPaneIds.delete(id)  // React 会触发 unmount
    }
  }
}

/**
 * 判断是否为 cache hit（previous 中存在目标会话）。
 * current 不算 cache hit——它的数据总是从 store 读取。
 */
export function keepAliveIsCached(id: string): boolean {
  return previousEntry?.conversationId === id
}

/**
 * 删除会话时清理缓存。
 */
export function keepAliveEvictDeleted(id: string): void {
  if (previousEntry?.conversationId === id) {
    console.log('[keepalive] cache evict id=%s', id.slice(0, 8))
    previousEntry = null
  }
  if (currentPaneId === id) {
    currentPaneId = null
  }
  mountedPaneIds.delete(id)
}

/**
 * ChatView 请求挂载某 pane。
 */
export function keepAliveMount(id: string): PaneEntry | null {
  if (!mountedPaneIds.has(id)) {
    mountedPaneIds.add(id)
    console.log('[keepalive] pane mount id=%s', id.slice(0, 8))
  } else {
    console.log('[keepalive] pane show id=%s', id.slice(0, 8))
  }
  if (previousEntry?.conversationId === id) return previousEntry
  return null
}

/**
 * React 真正 unmount pane 时调用。
 */
export function keepAliveUnmount(id: string): void {
  if (mountedPaneIds.has(id)) {
    mountedPaneIds.delete(id)
    console.log('[keepalive] pane unmount id=%s', id.slice(0, 8))
  }
}

/**
 * ChatView 读取当前应该挂载的所有 pane id（current + previous）。
 */
export function keepAliveGetPaneIdsToMount(): string[] {
  const ids: string[] = []
  if (currentPaneId) ids.push(currentPaneId)
  if (previousEntry) ids.push(previousEntry.conversationId)
  return ids
}

/**
 * 取 previous pane 的 PaneEntry（hidden pane 用 snapshot）。
 */
export function keepAliveGetPreviousEntry(): PaneEntry | null {
  return previousEntry
}

/**
 * 判断某 pane 是否为 current（active）。
 */
export function keepAliveIsCurrent(id: string): boolean {
  return currentPaneId === id
}

/**
 * 清空所有缓存（clearAll / removeAll 时调用）。
 */
export function keepAliveReset(): void {
  if (previousEntry) {
    console.log('[keepalive] cache evict id=%s', previousEntry.conversationId.slice(0, 8))
  }
  previousEntry = null
  currentPaneId = null
  mountedPaneIds.clear()
}
