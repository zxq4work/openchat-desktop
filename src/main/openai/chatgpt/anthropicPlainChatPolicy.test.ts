import { describe, it, expect } from 'vitest'
import { shouldIncludeNoSearchNotice } from './anthropicPlainChatPolicy'

const notice = (over: Partial<Parameters<typeof shouldIncludeNoSearchNotice>[0]>) =>
  shouldIncludeNoSearchNotice({
    protocol: 'anthropic_messages',
    searchEnabledThisTurn: false,
    hasSearchHistory: false,
    hasProvenanceContext: false,
    ...over,
  })

describe('shouldIncludeNoSearchNotice', () => {
  it('Anthropic 从未搜索 → 不追加（与用户提示词 / instructions 无关）', () => {
    expect(notice({})).toBe(false)
  })

  it('Anthropic 历史搜索已由 provenance 说明 → 不追加（避免与历史事实冲突）', () => {
    expect(notice({ hasSearchHistory: true, hasProvenanceContext: true })).toBe(false)
  })

  it('Anthropic 历史搜索但无 provenance → 兜底追加', () => {
    expect(notice({ hasSearchHistory: true, hasProvenanceContext: false })).toBe(true)
  })

  it('Anthropic 本轮搜索已启用（PreSearch 回退）→ 追加（保持既有流程，未改搜索执行链路）', () => {
    expect(notice({ searchEnabledThisTurn: true })).toBe(true)
    expect(notice({ searchEnabledThisTurn: true, hasSearchHistory: true, hasProvenanceContext: true })).toBe(true)
  })

  it('其它协议：无历史时保持原行为（恒 true）', () => {
    for (const p of ['chat_completions', 'responses', 'chatgpt_codex']) {
      expect(notice({ protocol: p })).toBe(true)
      expect(notice({ protocol: p, hasSearchHistory: true, hasProvenanceContext: false })).toBe(true)
      expect(notice({ protocol: p, searchEnabledThisTurn: true })).toBe(true)
    }
  })

  it('任何协议：已注入 provenance → 不追加（消除与历史事实的冲突）', () => {
    for (const p of ['anthropic_messages', 'chat_completions', 'responses', 'chatgpt_codex']) {
      expect(notice({ protocol: p, hasSearchHistory: true, hasProvenanceContext: true })).toBe(false)
    }
  })
})
