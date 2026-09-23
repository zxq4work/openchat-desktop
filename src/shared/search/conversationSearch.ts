// 全局会话搜索的纯函数工具：转义 / 片段 / 高亮拆分 / 排序。
// 无副作用、无 DB 依赖，主进程与渲染进程共用，单元测试直接覆盖。

import type { ConversationSearchResult, ConversationSearchScope } from '../types/search'

export interface ConversationSummaryRow {
  id: string
  title: string
  updatedAt: number
}

export interface ContentHit {
  conversationId: string
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

// 聚合全局搜索结果：按 Conversation 分组（一个会话只出现一次），
// 计算 titleMatched / contentMatchCount / bestMatch，并按排序优先级输出。
// 纯函数，便于单元测试（不依赖 DB / electron）。
export function aggregateConversationSearchResults(params: {
  query: string
  scope: ConversationSearchScope
  // 候选会话摘要（标题匹配 ∪ 正文命中）
  candidateSummaries: ConversationSummaryRow[]
  // 所有正文命中消息（调用方已按 scope 决定是否传入）
  contentHits: ContentHit[]
}): ConversationSearchResult[] {
  const { query, scope, candidateSummaries, contentHits } = params
  const q = query.trim()
  if (!q) return []
  const lower = q.toLowerCase()
  const wantTitle = scopeMatchesTitle(scope)
  const wantContent = scopeMatchesContent(scope)

  // 按会话归组正文命中
  const hitsByConversation = new Map<string, ContentHit[]>()
  if (wantContent) {
    for (const hit of contentHits) {
      const list = hitsByConversation.get(hit.conversationId)
      if (list) list.push(hit)
      else hitsByConversation.set(hit.conversationId, [hit])
    }
  }

  const results: ConversationSearchResult[] = []
  for (const summary of candidateSummaries) {
    const titleMatched = wantTitle && summary.title.toLowerCase().includes(lower)
    const hits = hitsByConversation.get(summary.id) ?? []
    if (!titleMatched && hits.length === 0) continue

    const result: ConversationSearchResult = {
      conversationId: summary.id,
      title: summary.title,
      updatedAt: summary.updatedAt,
      titleMatched,
      contentMatchCount: hits.length,
    }
    if (hits.length > 0) {
      const first = hits[0]
      result.bestMatch = {
        messageId: first.messageId,
        role: first.role,
        snippet: buildSnippet(first.content, q),
        createdAt: first.createdAt,
      }
    }
    results.push(result)
  }

  return rankConversationSearchResults(results, q)
}

// LIKE 特殊字符转义。SQL 使用 `LIKE ? ESCAPE '\'`，
// 键：查找串用 `ESCAPE '\'` 时 `%` `_` 视为通配，`\` 为转义符 → 统一前缀转义。
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => '\\' + c)
}

// 生成可读片段：命中关键词尽量居中；折叠空白与换行；截断处加省略号。
// 不修改原始 message 数据，仅用于展示。
export function buildSnippet(content: string, query: string, max = 160): string {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const q = String(query ?? '')
  if (!q) return text.length > max ? text.slice(0, max) + '…' : text

  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) {
    return text.length > max ? text.slice(0, max) + '…' : text
  }

  // 命中点前后各留一段上下文；q 越长，前缀越短，保证命中点大致居中。
  const contextBefore = Math.max(0, Math.floor((max - q.length) / 2))
  const start = Math.max(0, idx - contextBefore)
  const end = Math.min(text.length, start + max)

  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end) + suffix
}

// 将文本按 query 拆分为 [{text, matched}] 片段，供 React 安全高亮（不使用 dangerouslySetInnerHTML）。
// 大小写不敏感匹配，但保留原文大小写。
export function splitMatchedText(text: string, query: string): Array<{ text: string; matched: boolean }> {
  const src = String(text ?? '')
  const q = String(query ?? '')
  if (!q) return [{ text: src, matched: false }]

  const lowerSrc = src.toLowerCase()
  const lowerQ = q.toLowerCase()
  const parts: Array<{ text: string; matched: boolean }> = []
  let last = 0
  let idx = lowerSrc.indexOf(lowerQ)
  while (idx !== -1) {
    if (idx > last) parts.push({ text: src.slice(last, idx), matched: false })
    parts.push({ text: src.slice(idx, idx + q.length), matched: true })
    last = idx + q.length
    idx = lowerSrc.indexOf(lowerQ, last)
  }
  if (last < src.length) parts.push({ text: src.slice(last), matched: false })
  return parts.length > 0 ? parts : [{ text: src, matched: false }]
}

// 排序优先级：标题完全等于 query > 标题以 query 开头 > 标题包含 query > 正文命中 > updatedAt 较新。
// 保持代码简单，不引入复杂搜索算法。
export function rankConversationSearchResults(
  results: ConversationSearchResult[],
  query: string
): ConversationSearchResult[] {
  const q = String(query ?? '').toLowerCase()
  const rank = (r: ConversationSearchResult): number => {
    const title = r.title.toLowerCase()
    if (title === q) return 0
    if (title.startsWith(q)) return 1
    if (r.titleMatched) return 2
    return 3
  }
  return [...results].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return b.updatedAt - a.updatedAt
  })
}

// scope 辅助：是否需要匹配标题 / 正文。
export function scopeMatchesTitle(scope: ConversationSearchScope): boolean {
  return scope === 'all' || scope === 'title'
}

export function scopeMatchesContent(scope: ConversationSearchScope): boolean {
  return scope === 'all' || scope === 'content'
}
