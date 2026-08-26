import type { SearchEngine } from './WebSearchService'
import type { SearchResultItem } from '../../shared/types/provider'
import { googleSearchBrowser } from './GoogleSearchBrowserService'

/**
 * 使用 Electron BrowserWindow 渲染 Google 搜索页面。
 * 替代 GoogleHtmlSearchEngine，因为 Google 现在要求 JavaScript 执行。
 */
export class GoogleBrowserSearchEngine implements SearchEngine {
  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    console.log('[WebSearch] engine=google-browser query=', query)
    return googleSearchBrowser.search(query, signal)
  }
}