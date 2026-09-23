import { describe, it, expect } from 'vitest'
import { derivePendingLocate, decideLocate, type PendingLocate } from './locateMessage'
import type { ConversationMessageSearchMatch } from '../../shared/types/search'

function match(messageId: string): ConversationMessageSearchMatch {
  return { messageId, role: 'user', snippet: 's', createdAt: 1 }
}

describe('derivePendingLocate — 从搜索状态派生待定位请求', () => {
  const matches = [match('m1'), match('m2')]

  it('locateRequestId<=0 时不产生请求（初次进入会话不定位）', () => {
    expect(derivePendingLocate(0, 'c1', matches, 0)).toBeNull()
  })

  it('无导航会话 / 无有效命中时不产生请求', () => {
    expect(derivePendingLocate(3, null, matches, 0)).toBeNull()
    expect(derivePendingLocate(3, 'c1', [], 0)).toBeNull()
    // 有效命中列表但 index 越界（例如 closeNavBar 后）→ 无请求
    expect(derivePendingLocate(3, 'c1', matches, 5)).toBeNull()
  })

  it('正常派生：取当前会话 + 当前 index 指向的 message', () => {
    expect(derivePendingLocate(7, 'c1', matches, 1)).toEqual({
      conversationId: 'c1', messageId: 'm2', requestId: 7,
    })
  })
})

describe('decideLocate — 待定位请求的处置', () => {
  const pending: PendingLocate = { conversationId: 'c1', messageId: 'm1', requestId: 7 }

  it('无请求 → drop（不等待）', () => {
    expect(decideLocate(null, 'c1', ['m1'])).toBe('drop')
  })

  it('目标消息尚未挂载 → wait（保持 pending，等 messages 变化重试）', () => {
    // 命中消息来自数据库，但 activeMessages 里还没有它 → 必须等待，不能丢掉定位
    expect(decideLocate(pending, 'c1', ['other'])).toBe('wait')
    expect(decideLocate(pending, 'c1', [])).toBe('wait')
  })

  it('目标消息已挂载 → locate', () => {
    expect(decideLocate(pending, 'c1', ['other', 'm1'])).toBe('locate')
  })

  it('会话已切换 → drop（不把旧会话的定位错位到新会话）', () => {
    expect(decideLocate(pending, 'c2', ['m1'])).toBe('drop')
  })

  it('当前会话尚未确定（加载中）→ wait（不误丢弃）', () => {
    expect(decideLocate(pending, null, ['m1'])).toBe('wait')
  })
})
