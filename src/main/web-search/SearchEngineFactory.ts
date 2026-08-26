import type { SearchEngine } from './WebSearchService'
import type { WebSearchEngineType } from '../../shared/types/settings'
import { BingHtmlSearchEngine } from './BingHtmlSearchEngine'
import { BaiduHtmlSearchEngine } from './BaiduHtmlSearchEngine'
import { GoogleHtmlSearchEngine } from './GoogleHtmlSearchEngine'

let bingEngine: BingHtmlSearchEngine | null = null
let baiduEngine: BaiduHtmlSearchEngine | null = null
let googleEngine: GoogleHtmlSearchEngine | null = null

export function getSearchEngine(type: WebSearchEngineType): SearchEngine {
  switch (type) {
    case 'baidu':
      if (!baiduEngine) {
        baiduEngine = new BaiduHtmlSearchEngine()
      }
      return baiduEngine
    case 'google':
      if (!googleEngine) {
        googleEngine = new GoogleHtmlSearchEngine()
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