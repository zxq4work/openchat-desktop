import * as https from 'https'
import type { IncomingMessage } from 'http'
import * as cheerio from 'cheerio'
import type { SearchEngine } from './WebSearchService'
import type { SearchResultItem } from '../../shared/types/provider'
import { getProxyAgent } from '../openai/chatgpt/httpsClient'

const GOOGLE_SEARCH_URL = 'https://www.google.com/search'
const MAX_RESULTS = 10

// Google 内部链接/非内容页面，不应作为搜索结果
const GOOGLE_INTERNAL_PATTERNS = [
  /^https?:\/\/accounts\.google\.com\//,
  /^https?:\/\/support\.google\.com\//,
  /^https?:\/\/policies\.google\.com\//,
]

function isGoogleInternalUrl(url: string): boolean {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false
  return GOOGLE_INTERNAL_PATTERNS.some((p) => p.test(url))
}

function isGoogleNavigationUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.hostname === 'www.google.com' || u.hostname === 'google.com') {
      const path = u.pathname
      if (
        path === '/search' ||
        path === '/preferences' ||
        path === '/advanced_search' ||
        path.startsWith('/search') ||
        path.startsWith('/setprefs')
      ) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

// 从 Google redirect URL 提取真实目标 URL
function extractRealUrl(href: string): string | null {
  if (!href) return null

  // 直接 URL
  if (href.startsWith('http://') || href.startsWith('https://')) {
    const u = new URL(href)
    if (u.hostname === 'www.google.com' || u.hostname === 'google.com') {
      const q = u.searchParams.get('q') || u.searchParams.get('url')
      if (q && (q.startsWith('http://') || q.startsWith('https://'))) {
        return q
      }
      return null
    }
    return href
  }

  // 相对路径 /url?q=...
  if (href.startsWith('/url')) {
    try {
      const u = new URL(href, 'https://www.google.com')
      const q = u.searchParams.get('q') || u.searchParams.get('url')
      if (q && (q.startsWith('http://') || q.startsWith('https://'))) {
        return q
      }
    } catch {
      // ignore
    }
  }

  return null
}

export class GoogleHtmlSearchEngine implements SearchEngine {
  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const url = new URL(GOOGLE_SEARCH_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('hl', 'zh-CN')
    const urlStr = url.toString()

    console.log('[WebSearch] engine=google query=', query)
    const html = await this.fetchHtml(urlStr, signal)
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
          if (res.statusCode === 429) {
            cleanup()
            reject(new Error('SEARCH_RATE_LIMITED: Google returned 429'))
            return
          }

          if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location
            if (location) {
              const redirected = new URL(location, url).toString()
              cleanup()
              resolve(this.fetchHtml(redirected, signal))
            } else {
              reject(new Error(`Google search redirect without location (${res.statusCode})`))
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
          reject(new Error(`Google search failed with status ${res.statusCode ?? 0}`))
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

    // 检测 CAPTCHA / unusual traffic
    const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase()
    if (
      bodyText.includes('unusual traffic') ||
      bodyText.includes('not a robot') ||
      bodyText.includes('captcha') ||
      bodyText.includes('verify you\'re not a robot')
    ) {
      console.log('[WebSearch] engine=google error=google_challenge')
      throw new Error('SEARCH_PROVIDER_UNAVAILABLE: Google challenge page detected')
    }

    const results: SearchResultItem[] = []
    const seenUrls = new Set<string>()

    const $h3s = $('h3')
    if (!$h3s.length) {
      throw new Error('SEARCH_INVALID_RESPONSE: Google search returned no parseable results')
    }

    $h3s.each((_i, h3El) => {
      if (results.length >= MAX_RESULTS) return false

      const $h3 = $(h3El)
      const title = $h3.text().replace(/\s+/g, ' ').trim()
      if (!title) return

      // 找到包含 h3 的 a 标签
      let $anchor = $h3.closest('a')
      if (!$anchor.length) {
        // 向父级查找包含 h3 的 a
        $anchor = $h3.parent().find('a').first()
      }
      if (!$anchor.length) return

      const href = $anchor.attr('href')
      if (!href) return

      const url = extractRealUrl(href)
      if (!url) return
      if (isGoogleInternalUrl(url)) return
      if (isGoogleNavigationUrl(url)) return

      // 去重
      if (seenUrls.has(url)) return
      seenUrls.add(url)

      // 找结果容器
      let resultContainer = $h3.closest('.MjjYud')
      if (!resultContainer.length) {
        resultContainer = $h3.parent().parent()
      }

      // 检查是否为广告
      const containerText = resultContainer.text().toLowerCase()
      if (
        containerText.includes('sponsored') ||
        containerText.includes('广告')
      ) {
        return
      }

      // snippet
      let snippet = ''
      const vwi = resultContainer.find('.VwiC3b').first()
      if (vwi.length) {
        snippet = vwi.text()
      } else {
        const sncf = resultContainer.find('[data-sncf]').first()
        if (sncf.length) {
          snippet = sncf.text()
        }
      }

      if (!snippet) {
        // fallback: 从容器文本中移除标题后取剩余部分
        const allText = resultContainer.text().replace(/\s+/g, ' ').trim()
        const idx = allText.indexOf(title)
        if (idx >= 0) {
          snippet = allText.slice(idx + title.length).trim().slice(0, 500)
        } else {
          snippet = allText.slice(0, 500)
        }
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
      throw new Error('SEARCH_INVALID_RESPONSE: Google search returned no parseable results')
    }

    console.log('[WebSearch] engine=google parsedResults=', results.length)
    return results
  }
}