import * as https from 'https'
import type { IncomingMessage } from 'http'
import * as cheerio from 'cheerio'
import type { SearchEngine } from './WebSearchService'
import type { SearchResultItem } from '../../shared/types/provider'
import { getProxyAgent } from '../openai/chatgpt/httpsClient'

const BING_SEARCH_URL = 'https://www.bing.com/search'
const MAX_RESULTS = 10

export class BingHtmlSearchEngine implements SearchEngine {
  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const url = `${BING_SEARCH_URL}?q=${encodeURIComponent(query)}`
    const html = await this.fetchHtml(url, signal)
    return this.parseResults(html)
  }

  private fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const headers: Record<string, string> = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }

      const req = https.request(
        {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
          agent: getProxyAgent(),
        },
        (res: IncomingMessage) => {
          if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location
            if (location) {
              const redirected = new URL(location, url).toString()
              cleanup()
              resolve(this.fetchHtml(redirected, signal))
            } else {
              reject(new Error(`Bing search redirect without location (${res.statusCode})`))
            }
            return
          }

          if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              cleanup()
              resolve(Buffer.concat(chunks).toString('utf8'))
            })
            return
          }

          res.resume()
          cleanup()
          reject(new Error(`Bing search failed with status ${res.statusCode ?? 0}`))
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
    const results: SearchResultItem[] = []

    $('#b_results > li.b_algo').each((_i, el) => {
      if (results.length >= MAX_RESULTS) return false

      const $li = $(el)
      const $link = $li.find('h2 > a').first()
      const $altLink = $li.find('a.tilk').first()

      const href = $link.attr('href') || $altLink.attr('href')
      if (!href) return

      const title =
        $link.attr('aria-label') ||
        $link.text() ||
        $altLink.attr('aria-label') ||
        $altLink.text()

      if (!title || !title.trim()) return

      const $snippet = $li.find('p[class^="b_lineclamp"]').first()
      const snippet = $snippet.text() || $li.find('.b_caption p').first().text()

      results.push({
        index: results.length + 1,
        title: title.trim(),
        url: href,
        snippet: snippet.trim(),
      })
    })

    return results
  }
}