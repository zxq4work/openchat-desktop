import { describe, it, expect, vi } from 'vitest'

// CodexStandaloneWebRunTool 经 searchClient 间接依赖 httpsClient 的 electron net/session。
// 本测试只断言工具层行为，不发起网络请求。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { CodexStandaloneWebRunTool } from './CodexStandaloneWebRunTool'
import type { ChatGPTCodexStandaloneSearchClient } from '../search/ChatGPTCodexStandaloneSearchClient'

function makeTool(search: ReturnType<typeof vi.fn>): CodexStandaloneWebRunTool {
  const fakeClient = { search } as unknown as ChatGPTCodexStandaloneSearchClient
  return new CodexStandaloneWebRunTool(fakeClient, 'gpt-5-codex', 'seg-1', [])
}

describe('CodexStandaloneWebRunTool command validation', () => {
  it('weather 缺 location → isError，绝不发请求', async () => {
    const search = vi.fn()
    const tool = makeTool(search)
    const result = await tool.execute({ weather: [{ date: '2026-10-10' }] }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('date')
    expect(search).not.toHaveBeenCalled()
  })

  it('weather 带不受支持的 date → isError，绝不发请求', async () => {
    const search = vi.fn()
    const tool = makeTool(search)
    const result = await tool.execute({ weather: [{ location: 'Beijing', date: '2026-10-10' }] }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('weather[0].date')
    expect(search).not.toHaveBeenCalled()
  })

  it('weather(location, start, duration) 合法 → 正常发请求', async () => {
    const search = vi.fn().mockResolvedValue({ output: 'ok', results: [], rawResults: [] })
    const tool = makeTool(search)
    const result = await tool.execute(
      { weather: [{ location: 'Beijing', start: '2026-10-10', duration: 2 }] },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(search).toHaveBeenCalledTimes(1)
    const sentRequest = search.mock.calls[0][0] as { commands: Record<string, unknown> }
    expect(sentRequest.commands).toEqual({ weather: [{ location: 'Beijing', start: '2026-10-10', duration: 2 }] })
  })

  it('search_query 不受 weather 校验影响，正常发请求', async () => {
    const search = vi.fn().mockResolvedValue({ output: 'ok', results: [], rawResults: [] })
    const tool = makeTool(search)
    const result = await tool.execute({ search_query: [{ q: '北京天气' }] }, {})
    expect(result.isError).toBeFalsy()
    expect(search).toHaveBeenCalledTimes(1)
  })
})
