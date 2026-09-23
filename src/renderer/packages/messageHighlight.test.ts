import { describe, it, expect } from 'vitest'
import { selectGlobalHighlightTarget } from './messageHighlight'

// selectGlobalHighlightTarget 是全局搜索高亮的纯策略函数（无 DOM 依赖）。
// 它决定「此刻是否应高亮、以及高亮哪条 Message」，调用方据 null 清除高亮。
function base(overrides: Partial<Parameters<typeof selectGlobalHighlightTarget>[0]> = {}) {
  return {
    highlightQuery: 'hello',
    navConversationId: 'conv-1',
    activeConversationId: 'conv-1',
    activeMatches: [{ messageId: 'msg-2' }],
    activeMatchIndex: 0,
    searchVisible: false,
    locateRequestId: 7,
    ...overrides,
  }
}

describe('selectGlobalHighlightTarget', () => {
  it('returns target on happy path', () => {
    expect(selectGlobalHighlightTarget(base())).toEqual({
      query: 'hello',
      messageId: 'msg-2',
      alignTick: 7,
    })
  })

  it('carries the locate token so the caller can align exactly once per navigation', () => {
    expect(selectGlobalHighlightTarget(base({ locateRequestId: 42 }))?.alignTick).toBe(42)
  })

  it('trims the frozen query snapshot', () => {
    expect(selectGlobalHighlightTarget(base({ highlightQuery: '  hello  ' }))?.query).toBe('hello')
  })

  it('returns null for empty / whitespace-only query', () => {
    expect(selectGlobalHighlightTarget(base({ highlightQuery: '' }))).toBeNull()
    expect(selectGlobalHighlightTarget(base({ highlightQuery: '   ' }))).toBeNull()
  })

  it('returns null when Cmd/Ctrl+F is open (local search owns highlighting)', () => {
    expect(selectGlobalHighlightTarget(base({ searchVisible: true }))).toBeNull()
  })

  it('returns null when nav conversation has not been established', () => {
    expect(selectGlobalHighlightTarget(base({ navConversationId: null }))).toBeNull()
  })

  it('returns null when active conversation differs from nav conversation', () => {
    expect(selectGlobalHighlightTarget(base({ activeConversationId: 'conv-2' }))).toBeNull()
    expect(selectGlobalHighlightTarget(base({ activeConversationId: null }))).toBeNull()
  })

  it('returns null when there are no active matches', () => {
    expect(selectGlobalHighlightTarget(base({ activeMatches: [] }))).toBeNull()
  })

  it('returns null when active match index is out of range', () => {
    expect(selectGlobalHighlightTarget(base({ activeMatchIndex: -1 }))).toBeNull()
    expect(selectGlobalHighlightTarget(base({ activeMatchIndex: 5 }))).toBeNull()
  })

  it('follows the active match index', () => {
    const input = base({
      activeMatches: [{ messageId: 'msg-a' }, { messageId: 'msg-b' }],
      activeMatchIndex: 1,
    })
    expect(selectGlobalHighlightTarget(input)).toEqual({
      query: 'hello',
      messageId: 'msg-b',
      alignTick: 7,
    })
  })
})
