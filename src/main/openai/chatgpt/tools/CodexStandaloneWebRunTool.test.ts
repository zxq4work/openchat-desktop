import { describe, it, expect, vi } from 'vitest'

// CodexStandaloneWebRunTool 经 searchClient 间接依赖 httpsClient 的 electron net/session。
// 本测试只断言工具定义文案，不发起网络请求。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { CODEX_WEB_RUN_TOOL_DEFINITION } from './CodexStandaloneWebRunTool'

// web.run 的 description 不能只强调 search，
// 否则模型会把所有联网需求都路由成 search_query。

describe('CODEX_WEB_RUN_TOOL_DEFINITION', () => {
  it('keeps the web.run name and namespace', () => {
    expect(CODEX_WEB_RUN_TOOL_DEFINITION.name).toBe('run')
    expect(CODEX_WEB_RUN_TOOL_DEFINITION.namespace).toBe('web')
  })

  it('describes both searching and opening/reading webpages', () => {
    const description = CODEX_WEB_RUN_TOOL_DEFINITION.description.toLowerCase()
    expect(description).toContain('search')
    expect(description).toContain('open')
    expect(description).toContain('read')
    expect(description).toContain('webpage')
  })

  it('documents fully-qualified URL support for open', () => {
    const description = CODEX_WEB_RUN_TOOL_DEFINITION.description.toLowerCase()
    expect(description).toContain('fully-qualified')
    expect(description).toContain('http/https')
    expect(description).toContain('url')
  })

  it('prefers opening a supplied URL instead of searching for it first', () => {
    const description = CODEX_WEB_RUN_TOOL_DEFINITION.description.toLowerCase()
    expect(description).toContain('prefer opening the url directly')
  })
})
