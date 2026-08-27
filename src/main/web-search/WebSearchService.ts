import type { SearchResultItem } from '../../shared/types/provider'

export interface SearchEngine {
  search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]>
}

interface CacheEntry {
  results: SearchResultItem[]
  timestamp: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const EMPTY_CACHE_TTL_MS = 30 * 1000
const MAX_RESULTS = 10
const MAX_SNIPPET_LENGTH = 150

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

export class WebSearchService {
  private engine: SearchEngine
  private engineName: string
  private cache: Map<string, CacheEntry> = new Map()

  constructor(engine: SearchEngine, engineName = 'unknown') {
    this.engine = engine
    this.engineName = engineName
  }

  setEngine(engine: SearchEngine, engineName?: string): void {
    this.engine = engine
    if (engineName) this.engineName = engineName
    this.cache.clear()
  }

  getEngineName(): string {
    return this.engineName
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const key = normalizeQuery(query)
    const cached = this.cache.get(key)
    if (cached && cached.timestamp > Date.now()) {
      return cached.results
    }

    try {
      const raw = await this.engine.search(query, signal)
      const results = raw.slice(0, MAX_RESULTS).map((r, i) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet.slice(0, MAX_SNIPPET_LENGTH),
      }))

      const ttl = results.length === 0 ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS
      this.cache.set(key, { results, timestamp: Date.now() + ttl })

      return results
    } catch (err) {
      if (signal?.aborted) {
        throw err
      }
      // 网络错误不缓存
      throw err
    }
  }

  clearCache(): void {
    this.cache.clear()
  }
}