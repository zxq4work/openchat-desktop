import { describe, it, expect } from 'vitest'
import {
  mapStandaloneServerResults,
  hasWeatherCommand,
  parseRunCommands,
  buildWeatherServiceSource,
  buildStandaloneWebSearchResults,
} from './standaloneSourceAdapter'
import type { SearchCommands } from '../../../../shared/types/webSearch'

// Standalone 展示来源适配：服务端 results 归一 vs OpenChat 依据真实 weather 调用
// 补充的内置服务来源，两者在代码层面区分；绝不伪造 URL、绝不从自然语言推断。

const WEB_QUERY: SearchCommands = { search_query: [{ q: '北京天气 网页' }] }
const WEATHER_CMD: SearchCommands = { weather: [{ location: '北京' }] }

describe('parseRunCommands', () => {
  it('解析合法 JSON', () => {
    expect(parseRunCommands(JSON.stringify(WEATHER_CMD))).toEqual(WEATHER_CMD)
  })
  it('非 JSON / 空 → undefined', () => {
    expect(parseRunCommands('not json')).toBeUndefined()
    expect(parseRunCommands('')).toBeUndefined()
    expect(parseRunCommands(undefined)).toBeUndefined()
  })
})

describe('mapStandaloneServerResults', () => {
  it('服务端 results → sourceType:web，title/url/snippet 映射（name/link/description 兜底）', () => {
    const out = mapStandaloneServerResults([
      { title: 'T', url: 'https://a.example', snippet: 'S' },
      { name: 'N', link: 'https://b.example', description: 'D' },
    ])
    expect(out).toEqual([
      { title: 'T', url: 'https://a.example', snippet: 'S', sourceType: 'web' },
      { title: 'N', url: 'https://b.example', snippet: 'D', sourceType: 'web' },
    ])
  })
  it('空 / 非数组 → []', () => {
    expect(mapStandaloneServerResults([])).toEqual([])
    expect(mapStandaloneServerResults(undefined)).toEqual([])
  })
})

describe('buildStandaloneWebSearchResults', () => {
  it('weather 成功、results 空 → 仅内置服务来源，url 为 null，无伪造链接', () => {
    const out = buildStandaloneWebSearchResults(WEATHER_CMD, [], true)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' })
  })

  it('weather 失败 → 不生成内置服务来源', () => {
    expect(buildStandaloneWebSearchResults(WEATHER_CMD, [], false)).toEqual([])
  })

  it('无 weather 命令（search_query + 11 results）→ 只保留网页来源，不加 api 来源', () => {
    const raw = Array.from({ length: 11 }, (_, i) => ({ title: `t${i}`, url: `https://s${i}.example`, snippet: 's' }))
    const out = buildStandaloneWebSearchResults(WEB_QUERY, raw, true)
    expect(out).toHaveLength(11)
    expect(out.every((r) => r.sourceType === 'web')).toBe(true)
    expect(out.some((r) => r.sourceType === 'api')).toBe(false)
  })

  it('混合命令（weather + search_query 同轮）→ 网页来源与内置服务来源都保留，不互相覆盖', () => {
    const mixed: SearchCommands = { search_query: [{ q: 'q' }], weather: [{ location: '北京' }] }
    const out = buildStandaloneWebSearchResults(mixed, [{ title: 'W', url: 'https://w.example' }], true)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ title: 'W', url: 'https://w.example', snippet: null, sourceType: 'web' })
    expect(out[1]).toEqual({ title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' })
  })

  it('多个 weather 只补充一次内置服务来源', () => {
    const two: SearchCommands = { weather: [{ location: '北京' }, { location: '上海' }] }
    const out = buildStandaloneWebSearchResults(two, [], true)
    expect(out.filter((r) => r.sourceType === 'api')).toHaveLength(1)
  })

  it('不修改原始 rawResults（服务端 data.results 保持不变）', () => {
    const raw = [{ title: 'T', url: 'https://a.example' }]
    buildStandaloneWebSearchResults(WEB_QUERY, raw, true)
    expect(raw).toEqual([{ title: 'T', url: 'https://a.example' }])
  })
})

describe('helpers', () => {
  it('hasWeatherCommand 只认非空 weather 数组', () => {
    expect(hasWeatherCommand(WEATHER_CMD)).toBe(true)
    expect(hasWeatherCommand(WEB_QUERY)).toBe(false)
    expect(hasWeatherCommand({ weather: [] })).toBe(false)
    expect(hasWeatherCommand(undefined)).toBe(false)
  })
  it('buildWeatherServiceSource 结构固定', () => {
    expect(buildWeatherServiceSource()).toEqual({ title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' })
  })
})

// 历史恢复：来源经 store → DB（JSON.stringify/parse）→ rowToMessage 后必须保持类型与 url:null。
describe('历史恢复（序列化往返）', () => {
  it('内置服务来源往返后 sourceType/url 不丢失', () => {
    const persisted = buildStandaloneWebSearchResults(WEATHER_CMD, [], true)
    const roundTripped = JSON.parse(JSON.stringify(persisted)) as typeof persisted
    expect(roundTripped).toEqual([{ title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' }])
  })

  it('混合来源往返：网页 url 与内置服务 sourceType 都保留', () => {
    const mixed: SearchCommands = { search_query: [{ q: 'q' }], weather: [{ location: '北京' }] }
    const persisted = buildStandaloneWebSearchResults(mixed, [{ title: 'W', url: 'https://w.example' }], true)
    const roundTripped = JSON.parse(JSON.stringify(persisted)) as typeof persisted
    expect(roundTripped).toHaveLength(2)
    expect(roundTripped[0]).toMatchObject({ url: 'https://w.example', sourceType: 'web' })
    expect(roundTripped[1]).toMatchObject({ url: null, sourceType: 'api' })
  })
})
