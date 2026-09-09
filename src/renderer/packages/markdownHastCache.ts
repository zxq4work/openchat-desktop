/**
 * Markdown HAST Cache — LRU
 *
 * cache key:   message.id (UUID)
 * cache value: { content: string, hast: Root }
 * 命中条件:    entry.content === content（精确匹配，不用近似 hash）
 *
 * 只缓存 completed/stopped assistant message 的正文 content。
 * streaming / reasoning 不缓存。
 */

import type { Root } from 'hast'

interface CacheEntry {
  content: string
  hast: Root
}

const MAX_SIZE = 200

const cache = new Map<string, CacheEntry>()
// LRU 顺序：accessOrder — 每次 get 命中时重新插入到末尾

let hitCount = 0
let missCount = 0

export function hastCacheGet(id: string, content: string): Root | null {
  const entry = cache.get(id)
  if (entry && entry.content === content) {
    // LRU: 重新插入到末尾
    cache.delete(id)
    cache.set(id, entry)
    hitCount++
    return entry.hast
  }
  missCount++
  return null
}

export function hastCacheSet(id: string, content: string, hast: Root): void {
  // 如果已存在，先删除（更新位置到末尾）
  cache.delete(id)
  cache.set(id, { content, hast })

  // 驱逐超限条目（删除最早插入的 = Map 迭代顺序最前面的）
  while (cache.size > MAX_SIZE) {
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) {
      cache.delete(firstKey)
    }
  }
}

export function hastCacheDelete(id: string): void {
  cache.delete(id)
}

export function hastCacheClear(): void {
  cache.clear()
  hitCount = 0
  missCount = 0
}

export function hastCacheStats(): { size: number; hitCount: number; missCount: number } {
  return { size: cache.size, hitCount, missCount }
}

export function hastCacheResetStats(): void {
  hitCount = 0
  missCount = 0
}
