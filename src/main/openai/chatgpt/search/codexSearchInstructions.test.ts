import { describe, it, expect } from 'vitest'
import {
  CODEX_SEARCH_MODE_SEMANTICS,
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

describe('CODEX_SEARCH_MODE_SEMANTICS', () => {
  it('keeps the three distinct search mechanisms separate', () => {
    expect(CODEX_SEARCH_MODE_SEMANTICS).toContain('web_search_call')
    expect(CODEX_SEARCH_MODE_SEMANTICS).toContain('openchat_web_search')
    expect(CODEX_SEARCH_MODE_SEMANTICS).toContain('CODEX_SEARCH_MODE_SEMANTICS_V1')
  })

  it('is appended to both hosted and standalone instructions', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain('CODEX_SEARCH_MODE_SEMANTICS_V1')
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toContain('CODEX_SEARCH_MODE_SEMANTICS_V1')
  })
})
