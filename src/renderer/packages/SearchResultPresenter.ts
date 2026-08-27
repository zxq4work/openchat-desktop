// Best-effort presenter for search results
// results 为 unknown[]，任何字段缺失/未知结构不抛异常

export interface SearchResultCard {
  url?: string
  link?: string
  uri?: string
  title?: string
  name?: string
  snippet?: string
  description?: string
  text?: string
  raw: unknown
}

export function presentSearchResults(rawResults: unknown[]): SearchResultCard[] {
  return rawResults.map((item) => {
    const card: SearchResultCard = { raw: item }

    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>

      if (typeof obj.url === 'string') card.url = obj.url
      if (typeof obj.link === 'string') card.link = obj.link
      if (typeof obj.uri === 'string') card.uri = obj.uri
      if (typeof obj.title === 'string') card.title = obj.title
      if (typeof obj.name === 'string') card.name = obj.name
      if (typeof obj.snippet === 'string') card.snippet = obj.snippet
      if (typeof obj.description === 'string') card.description = obj.description
      if (typeof obj.text === 'string') card.text = obj.text
    }

    return card
  })
}