import { describe, it, expect } from 'vitest'
import {
  CODEX_HOSTED_SEARCH_MODE_MARKER,
  CODEX_STANDALONE_SEARCH_MODE_MARKER,
  CODEX_SEARCH_INSTRUCTIONS,
  CODEX_STANDALONE_SEARCH_INSTRUCTIONS,
} from './codexSearchInstructions'

// Hosted 搜索只注册 provider-native web_search，不存在 openchat_web_fetch。
// 该指令常量不得声明一个实际不存在的 Tool，否则会诱导模型输出伪函数调用。

describe('CODEX_SEARCH_INSTRUCTIONS (Hosted)', () => {
  it('does not reference the non-existent openchat_web_fetch tool', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('openchat_web_fetch')
  })

  it('still describes web_search capability', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain('web_search')
  })

  it('describes direct URL reading semantics', () => {
    const text = CODEX_SEARCH_INSTRUCTIONS.toLowerCase()
    expect(text).toContain('direct urls')
    expect(text).toContain('http/https')
    expect(text).toContain('url')
  })
})

describe('CODEX_STANDALONE_SEARCH_INSTRUCTIONS', () => {
  it('describes the direct URL contract for web.run', () => {
    const text = CODEX_STANDALONE_SEARCH_INSTRUCTIONS.toLowerCase()
    expect(text).toContain('fully-qualified http/https url')
    expect(text).toContain('open')
    expect(text).toContain('search_query')
  })

  it('instructs to open the exact URL rather than search for it first', () => {
    const text = CODEX_STANDALONE_SEARCH_INSTRUCTIONS.toLowerCase()
    expect(text).toContain('exact url')
    // 明确禁止先搜索同一 URL
    expect(text).toMatch(/do not run `?search_query`? merely to rediscover/)
  })

  it('warns against substituting a similarly-named page', () => {
    const text = CODEX_STANDALONE_SEARCH_INSTRUCTIONS.toLowerCase()
    expect(text).toContain('substitute')
  })

  it('does not reference the non-existent openchat_web_fetch tool', () => {
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).not.toContain('openchat_web_fetch')
  })
})

describe('按搜索策略隔离指令（Phase 2 根因修复）', () => {
  it('Hosted 指令携带自身模式标记，且绝不出现 Standalone 工具 web.run', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    // 关键：Hosted 指令不得再教模型 web.run / namespace web / Standalone 归因规则
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('web.run')
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('Standalone Web Search')
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('namespace')
  })

  it('Hosted 指令以第一人称自我识别为 Hosted Web Search', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain('Hosted Web Search')
    expect(CODEX_SEARCH_INSTRUCTIONS).toMatch(/Search mechanism for THIS turn/)
  })

  it('Standalone 指令携带自身模式标记，且绝不出现 Hosted 归因', () => {
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toContain(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).not.toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).not.toContain('Hosted Web Search')
  })

  it('Standalone 指令以第一人称自我识别为 web.run', () => {
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toContain('web.run')
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toMatch(/Search mechanism for THIS turn/)
  })

  it('两模式指令互不引用对方的工具机制（严格隔离）', () => {
    // Hosted 不含 web.run / namespace=web；Standalone 不含 provider-native web_search 归因
    expect(CODEX_SEARCH_INSTRUCTIONS.includes('web.run')).toBe(false)
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS.includes('Hosted Web Search')).toBe(false)
  })
})
