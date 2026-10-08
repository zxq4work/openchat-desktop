import type { WebSearchResultItem } from '../../../../shared/types/conversation'
import { hostnameFromUrl } from '../../../../shared/utils/searchDisplay'

// Hosted Web Search 的结果归一化。
//
// 背景：Hosted 的 `search` action 会带 `action.sources`（多个网页），而
// `open_page` action 只带 `action.url`，`action.sources` 通常为空。此前只把
// `search.sources` 写入 webSearchResults，导致「用户明确给 URL → 模型 open_page」
// 这种真实访问了网页的场景，参考页面卡片是空的。
//
// 本函数把 open_page 访问的 URL 归一为一个普通的 WebSearchResultItem，合并进既有的
// webSearchResults —— 不新增任何联网 UI 概念，完全复用原有参考页面卡片。

interface HostedWebSearchAction {
  type?: string
  url?: string
  query?: string
  queries?: string[]
  pattern?: string
  sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }>
}

// URL 归一仅用于「去重判定」，不用于展示：合并 pathname 末尾 `/` 造成的重复，
// 但完整保留 query / hash 语义 —— 避免把两个真实不同的 URL 合并。
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1)
    }
    return u.href
  } catch {
    return url
  }
}

// action.type === 'open_page' 且有 url 时，把该 URL 补进参考页面列表（按归一 URL 去重）。
// 其余情况（search / find_in_page / 无 url）原样返回既有列表，不改变原有 search 行为。
export function mergeHostedWebSearchResults(
  action: HostedWebSearchAction | undefined,
  existing: WebSearchResultItem[]
): WebSearchResultItem[] {
  if (!action || action.type !== 'open_page' || !action.url) return existing

  const target = canonicalUrl(action.url)
  if (existing.some((item) => item.url && canonicalUrl(item.url) === target)) {
    return existing
  }

  return [
    ...existing,
    {
      // 与既有搜索来源一致：真实 title 缺失时用 hostname 兜底，完整 URL 由卡片下方单独展示
      title: hostnameFromUrl(action.url) ?? action.url,
      url: action.url,
      snippet: null,
      sourceType: 'web',
    },
  ]
}
