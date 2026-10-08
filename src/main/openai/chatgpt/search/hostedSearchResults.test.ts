import { describe, it, expect } from 'vitest'
import { mergeHostedWebSearchResults } from './hostedSearchResults'
import type { WebSearchResultItem } from '../../../../shared/types/conversation'

// Hosted open_page 的 URL 必须像普通 search source 一样进入参考页面列表。
// search 行为不变；按归一 URL 去重；不做过度 canonicalization。

function item(over: Partial<WebSearchResultItem>): WebSearchResultItem {
  return { title: null, url: null, snippet: null, sourceType: 'web', ...over }
}

describe('mergeHostedWebSearchResults', () => {
  it('search action：不改动既有来源', () => {
    const existing = [item({ title: 'a', url: 'https://a.example' })]
    const out = mergeHostedWebSearchResults({ type: 'search', query: 'x' }, existing)
    expect(out).toEqual(existing)
  })

  it('open_page 且 sources 为空：补一条参考页面', () => {
    const out = mergeHostedWebSearchResults({ type: 'open_page', url: 'https://github.com/zxq4work/openchat-desktop' }, [])
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('https://github.com/zxq4work/openchat-desktop')
    expect(out[0].title).toBe('github.com')
    expect(out[0].sourceType).toBe('web')
  })

  it('open_page 无 url：不改动', () => {
    const existing = [item({ title: 'a', url: 'https://a.example' })]
    expect(mergeHostedWebSearchResults({ type: 'open_page' }, existing)).toEqual(existing)
  })

  it('find_in_page：不产生独立参考页面', () => {
    const existing = [item({ title: 'a', url: 'https://a.example' })]
    expect(mergeHostedWebSearchResults({ type: 'find_in_page', url: 'https://a.example', pattern: 'x' }, existing)).toEqual(existing)
  })

  it('去重：search 已含同 URL 时 open_page 不再追加', () => {
    const existing = [item({ title: 'real', url: 'https://a.example' })]
    const out = mergeHostedWebSearchResults({ type: 'open_page', url: 'https://a.example' }, existing)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('real')
  })

  it('去重：仅合并路径末尾 /，保留 query/hash 语义', () => {
    const existing = [item({ url: 'https://a.example/page/' })]
    expect(mergeHostedWebSearchResults({ type: 'open_page', url: 'https://a.example/page' }, existing)).toHaveLength(1)
    // 不同 query 视为不同 URL，不得合并
    const withQuery = mergeHostedWebSearchResults({ type: 'open_page', url: 'https://a.example/page?x=1' }, existing)
    expect(withQuery).toHaveLength(2)
  })

  it('多个 open_page 累积（不同 URL）', () => {
    let out: WebSearchResultItem[] = []
    out = mergeHostedWebSearchResults({ type: 'open_page', url: 'https://a.example' }, out)
    out = mergeHostedWebSearchResults({ type: 'open_page', url: 'https://b.example' }, out)
    expect(out).toHaveLength(2)
    expect(out.map((i) => i.url)).toEqual(['https://a.example', 'https://b.example'])
  })

  it('非 URL fallback：无法解析的字符串原样作为 title', () => {
    const out = mergeHostedWebSearchResults({ type: 'open_page', url: 'not a url' }, [])
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('not a url')
    expect(out[0].title).toBe('not a url')
  })
})
