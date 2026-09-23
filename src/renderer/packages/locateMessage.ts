import type { ConversationMessageSearchMatch } from '../../shared/types/search'

// 一次「显式跳转到命中消息」的待办请求。
// requestId 来自 store.locateRequestId，用于保证每个请求只被消费一次。
export interface PendingLocate {
  conversationId: string
  messageId: string
  requestId: number
}

// 从搜索状态派生待定位请求。
// 没有显式跳转令牌（locateRequestId<=0）、命中列表不属于任何会话、或没有有效命中时返回 null。
export function derivePendingLocate(
  locateRequestId: number,
  matchConversationId: string | null,
  matches: readonly ConversationMessageSearchMatch[],
  activeMatchIndex: number,
): PendingLocate | null {
  if (locateRequestId <= 0 || !matchConversationId) return null
  const target = matches[activeMatchIndex]
  if (!target) return null
  return { conversationId: matchConversationId, messageId: target.messageId, requestId: locateRequestId }
}

export type LocateDecision = 'locate' | 'wait' | 'drop'

// 决定一次待定位请求的处置：
// - 'drop'   —— 请求不可满足（无请求 / 已切到别的会话），应消费掉，避免悬挂；
// - 'wait'   —— 目标尚未就绪（消息仍在异步加载，或当前会话尚未确定），保持 pending，
//               等 activeMessages / 当前会话变化后重新求值，而不是定时器轮询；
// - 'locate' —— 目标消息已在挂载列表中，执行滚动定位。
export function decideLocate(
  pending: PendingLocate | null,
  activeConversationId: string | null,
  mountedMessageIds: readonly string[],
): LocateDecision {
  if (!pending) return 'drop'
  // 当前会话尚未确定（会话加载中）：保持等待，避免过早丢弃
  if (activeConversationId === null) return 'wait'
  // 已切到别的会话：该请求属于旧会话，继续等会把视图错位到另一个会话
  if (activeConversationId !== pending.conversationId) return 'drop'
  return mountedMessageIds.includes(pending.messageId) ? 'locate' : 'wait'
}
