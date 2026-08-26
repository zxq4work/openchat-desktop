import type { SearchEngine } from './WebSearchService'
import type { WebSearchEngineType } from '../../shared/types/settings'
import { BingHtmlSearchEngine } from './BingHtmlSearchEngine'
import { BaiduHtmlSearchEngine } from './BaiduHtmlSearchEngine'
import { GoogleBrowserSearchEngine } from './GoogleBrowserSearchEngine'

let bingEngine: BingHtmlSearchEngine | null = null
let baiduEngine: BaiduHtmlSearchEngine | null = null
let googleEngine: GoogleBrowserSearchEngine | null = null

export function getSearchEngine(type: WebSearchEngineType): SearchEngine {
  switch (type) {
    case 'baidu':
      if (!baiduEngine) {
        baiduEngine = new BaiduHtmlSearchEngine()
      }
      return baiduEngine
    case 'google':
      if (!googleEngine) {
        googleEngine = new GoogleBrowserSearchEngine()
      }
      return googleEngine
    case 'bing':
    default:
      if (!bingEngine) {
        bingEngine = new BingHtmlSearchEngine()
      }
      return bingEngine
  }
}