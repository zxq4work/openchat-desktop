// 从 URL 提取 hostname 作为来源标题兜底
export function hostnameFromUrl(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

// 统一的搜索结果显示标题规则：真实 title → hostname → 原始 URL → "网页来源"
export function getSearchResultDisplayTitle(rawTitle: string | null, rawUrl: string | null): string | null {
  if (rawTitle) return rawTitle
  return hostnameFromUrl(rawUrl) ?? rawUrl ?? null
}