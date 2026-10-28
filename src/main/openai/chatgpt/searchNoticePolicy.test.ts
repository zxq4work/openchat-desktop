import { describe, it, expect } from 'vitest'
import { shouldIncludeNoSearchNotice } from './searchNoticePolicy'

// 搜索能力声明策略是**协议无关**的纯函数：同一组输入必须得到同一结果，
// 不允许任何协议（含 anthropic_messages）因协议名不同而改变注入决策。
const notice = (over: Partial<Parameters<typeof shouldIncludeNoSearchNotice>[0]>) =>
  shouldIncludeNoSearchNotice({
    searchEnabledThisTurn: false,
    hasProvenanceContext: false,
    ...over,
  })

describe('shouldIncludeNoSearchNotice（协议无关）', () => {
  it('搜索关闭、无历史、无 provenance → 注入统一声明', () => {
    expect(notice({})).toBe(true)
  })

  it('搜索关闭、已注入 provenance → 不注入（避免与历史事实冲突）', () => {
    expect(notice({ hasProvenanceContext: true })).toBe(false)
  })

  it('搜索功能已开启（Tools / PreSearch 成功·0结果·失败）→ 绝不注入关闭语义', () => {
    expect(notice({ searchEnabledThisTurn: true })).toBe(false)
    expect(notice({ searchEnabledThisTurn: true, hasProvenanceContext: true })).toBe(false)
  })

  it('函数签名不含 protocol 字段（不再有协议特殊分支）', () => {
    // 传入多余字段类型上即被拒绝；运行时也不会影响结果。
    const withBogusProtocol = shouldIncludeNoSearchNotice({
      searchEnabledThisTurn: false,
      hasProvenanceContext: false,
      // @ts-expect-error protocol 不再是决策输入
      protocol: 'anthropic_messages',
    })
    expect(withBogusProtocol).toBe(true)
  })
})
