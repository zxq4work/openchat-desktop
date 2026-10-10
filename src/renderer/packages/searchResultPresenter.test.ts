import { describe, it, expect } from 'vitest'
import { presentSearchResults } from './SearchResultPresenter'

// Hosted/Standalone 内置服务来源（sourceType:'api', url:null）必须能被现有 presentSearchResults
// 归一，且不产生可点击 URL —— 这是 Shared Provider / renderer 来源展示链路的最小回归守护。

describe('presentSearchResults（内置服务来源回归）', () => {
  it('api 来源：保留 title，url 缺省，raw.sourceType 可读', () => {
    const cards = presentSearchResults([
      { title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' },
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('内置服务: oai-weather')
    expect(cards[0].url).toBeUndefined()
    expect((cards[0].raw as Record<string, unknown>).sourceType).toBe('api')
  })

  it('网页来源：url/title 正常归一', () => {
    const cards = presentSearchResults([
      { title: 'T', url: 'https://a.example', snippet: 'S', sourceType: 'web' },
    ])
    expect(cards[0]).toMatchObject({ title: 'T', url: 'https://a.example', snippet: 'S' })
  })

  it('混合来源顺序保留，不互相覆盖', () => {
    const cards = presentSearchResults([
      { title: 'W', url: 'https://w.example', sourceType: 'web' },
      { title: '内置服务: oai-weather', url: null, sourceType: 'api' },
    ])
    expect(cards.map((c) => c.title)).toEqual(['W', '内置服务: oai-weather'])
  })
})
