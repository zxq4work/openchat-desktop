import { describe, it, expect } from 'vitest'
import { normalizeStandaloneRawResults } from './standaloneSearchResults'

// Standalone UI 结果归一化：
//   turn{N}view{M}（open 页面阅读）→ snippet 置空（reader 元数据不展示）
//   turn{N}search{M}（普通搜索）  → snippet 原样保留
// data.output 不在此函数处理范围内（另由调用方保持不变）。

function viewResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'text_result',
    ref_id: 'turn0view0',
    title: 'GitHub - zxq4work/openchat-desktop: 轻量级 ChatGPT / Codex 桌面聊天客户端 · GitHub',
    url: 'https://github.com/zxq4work/openchat-desktop',
    snippet: 'Total lines: 545',
    ...over,
  }
}

function searchResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'text_result',
    ref_id: 'turn0search0',
    title: 'Codex for every role, tool, and workflow | OpenAI',
    url: 'https://openai.com/index/codex-for-every-role-tool-workflow/',
    snippet: 'June 2, 2026 ... Inside OpenAI, non-technical teams use Codex ...',
    ...over,
  }
}

describe('normalizeStandaloneRawResults', () => {
  it('view result: snippet 置空，title/url/ref_id/type 保留', () => {
    const raw = viewResult()
    const out = normalizeStandaloneRawResults([raw]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(1)
    expect(out[0].snippet).toBeNull()
    expect(out[0].title).toBe(raw.title)
    expect(out[0].url).toBe(raw.url)
    expect(out[0].ref_id).toBe('turn0view0')
    expect(out[0].type).toBe('text_result')
  })

  it('search result: snippet 原样保留（同一引用，不复制）', () => {
    const raw = searchResult()
    const out = normalizeStandaloneRawResults([raw]) as Array<Record<string, unknown>>
    expect(out[0].snippet).toBe('June 2, 2026 ... Inside OpenAI, non-technical teams use Codex ...')
    expect(out[0]).toBe(raw)
  })

  it('混合列表：仅 view 被清理，search 不受影响，顺序保留', () => {
    const out = normalizeStandaloneRawResults([searchResult(), viewResult()]) as Array<Record<string, unknown>>
    expect(out[0].snippet).toBe('June 2, 2026 ... Inside OpenAI, non-technical teams use Codex ...')
    expect(out[1].snippet).toBeNull()
  })

  it('不修改原对象（view 返回新对象，原 snippet 不变）', () => {
    const raw = viewResult()
    normalizeStandaloneRawResults([raw])
    expect(raw.snippet).toBe('Total lines: 545')
  })

  it('多位数 view ref（turn12view3）同样清理', () => {
    const out = normalizeStandaloneRawResults([viewResult({ ref_id: 'turn12view3' })]) as Array<Record<string, unknown>>
    expect(out[0].snippet).toBeNull()
  })

  it('无 ref_id / ref_id 非 view 形态：不改动', () => {
    const noRef = { type: 'text_result', title: 't', url: 'https://x.example', snippet: 'keep' }
    const urlRef = { type: 'text_result', ref_id: 'https://y.example', snippet: 'keep' }
    const out = normalizeStandaloneRawResults([noRef, urlRef]) as Array<Record<string, unknown>>
    expect(out[0].snippet).toBe('keep')
    expect(out[1].snippet).toBe('keep')
  })

  it('非对象项原样保留', () => {
    const out = normalizeStandaloneRawResults(['x', null, 42])
    expect(out).toEqual(['x', null, 42])
  })

  it('幂等：重复归一 snippet 仍为 null', () => {
    const once = normalizeStandaloneRawResults([viewResult()])
    const twice = normalizeStandaloneRawResults(once) as Array<Record<string, unknown>>
    expect(twice[0].snippet).toBeNull()
  })

  it('持久化映射一致：view 归一后 snippet ?? description 为 null', () => {
    const out = normalizeStandaloneRawResults([viewResult()]) as Array<Record<string, unknown>>
    const persisted = (out[0].snippet as string | null) ?? (out[0].description as string | undefined) ?? null
    expect(persisted).toBeNull()
  })
})
