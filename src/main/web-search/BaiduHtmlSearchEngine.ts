import type { IncomingMessage } from 'http'
import * as cheerio from 'cheerio'
import type { SearchEngine } from './WebSearchService'
import type { SearchResultItem } from '../../shared/types/provider'
import { createRequest } from '../openai/chatgpt/httpsClient'

const BAIDU_SEARCH_URL = 'https://www.baidu.com/s'
const MAX_RESULTS = 10
// 防止返回异常超大的页面被 cheerio 全量解析导致主进程 OOM 崩溃
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export class BaiduHtmlSearchEngine implements SearchEngine {
  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const params = new URLSearchParams()
    params.set('ie', 'UTF-8')
    params.set('wd', query)
    const url = `${BAIDU_SEARCH_URL}?${params.toString()}`
    console.log('[BaiduSearch] request url=', url)
    const html = await this.fetchHtml(url, signal)
    return this.parseResults(html)
  }

  private fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const headers: Record<string, string> = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
      }

      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
          protocol: 'https:',
        },
        (res: IncomingMessage) => {
          if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location
            if (location) {
              const redirected = new URL(location, url).toString()
              cleanup()
              resolve(this.fetchHtml(redirected, signal))
            } else {
              reject(new Error(`Baidu search redirect without location (${res.statusCode})`))
            }
            return
          }

          if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) {
            const chunks: Buffer[] = []
            let totalBytes = 0
            res.on('data', (chunk: Buffer) => {
              totalBytes += chunk.length
              if (totalBytes > MAX_RESPONSE_BYTES) {
                req.destroy(new Error('Baidu search response too large'))
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              cleanup()
              resolve(Buffer.concat(chunks).toString('utf8'))
            })
            return
          }

          res.resume()
          cleanup()
          reject(new Error(`Baidu search failed with status ${res.statusCode ?? 0}`))
        }
      )

      let abortHandler: (() => void) | null = null
      if (signal) {
        if (signal.aborted) {
          reject(new Error('Aborted'))
          return
        }
        abortHandler = () => {
          req.destroy(new Error('Aborted'))
          reject(new Error('Aborted'))
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      const cleanup = () => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
      }

      req.on('error', (err) => {
        cleanup()
        reject(err)
      })
      req.end()
    })
  }

  private parseResults(html: string): SearchResultItem[] {
    const $ = cheerio.load(html)

    const contentLeft = $('#content_left')
    if (!contentLeft.length) {
      throw new Error('SEARCH_INVALID_RESPONSE: Baidu search returned no parseable results')
    }

    const results: SearchResultItem[] = []
    const seenUrls = new Set<string>()

    contentLeft.find('div.c-container').each((_i, el) => {
      if (results.length >= MAX_RESULTS) return false

      const node = $(el)
      const tpl = node.attr('tpl') || ''

      // 排除非普通搜索结果
      if (tpl === 'recommend_list') return
      if (tpl.startsWith('rel-')) return

      // 提取标题
      const titleAnchor = node.find('h3 a').first()
      const title = titleAnchor.text().replace(/\s+/g, ' ').trim()
      if (!title) return

      // 提取 URL：优先 mu 属性，其次 data-log，最后 h3 a[href]
      let url = ''
      const mu = node.attr('mu')
      if (mu && (mu.startsWith('http://') || mu.startsWith('https://'))) {
        url = mu
      }

      if (!url) {
        // 尝试从 data-log 解析
        const dataLog = node.attr('data-log')
        if (dataLog) {
          try {
            const logObj = JSON.parse(dataLog)
            const logUrl = logObj?.mu || logObj?.url
            if (typeof logUrl === 'string' && (logUrl.startsWith('http://') || logUrl.startsWith('https://'))) {
              url = logUrl
            }
          } catch {
            // data-log 解析失败，忽略
          }
        }
      }

      if (!url) {
        const href = titleAnchor.attr('href')
        if (href) {
          url = href.trim()
        }
      }

      if (!url) return

      // 只保留 http/https 地址
      if (!url.startsWith('http://') && !url.startsWith('https://')) return

      // URL 去重
      if (seenUrls.has(url)) return
      seenUrls.add(url)

      // 提取 snippet
      let snippet = ''
      const abstractEl = node.find('.c-abstract').first()
      if (abstractEl.length) {
        snippet = abstractEl.text()
      } else {
        // 尝试查找 class 名包含 abstract 的元素
        const abstractLike = node.find('[class*="abstract"]').first()
        if (abstractLike.length) {
          snippet = abstractLike.text()
        }
      }

      if (!snippet) {
        // fallback：从结果块获取文本，移除标题
        const blockText = node.text().replace(/\s+/g, ' ').trim()
        snippet = blockText.length > 200 ? blockText.slice(0, 200) : blockText
      }

      snippet = snippet.replace(/\s+/g, ' ').trim()

      results.push({
        index: results.length + 1,
        title,
        url,
        snippet,
      })
    })

    if (results.length === 0) {
      throw new Error('SEARCH_INVALID_RESPONSE: Baidu search returned no parseable results')
    }

    console.log('[BaiduSearch] parsed results=', results.length)
    return results
  }
}