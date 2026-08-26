import type { IncomingMessage } from 'http'
import * as cheerio from 'cheerio'
import type { SearchEngine } from './WebSearchService'
import type { SearchResultItem } from '../../shared/types/provider'
import { createRequest } from '../openai/chatgpt/httpsClient'

const GOOGLE_SEARCH_URL = 'https://www.google.com/search'
const MAX_RESULTS = 10

type GoogleResponseType =
  | 'NORMAL_SERP'
  | 'CHALLENGE'
  | 'CONSENT'
  | 'RATE_LIMITED'
  | 'UNKNOWN'

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

function detectGoogleResponseType(
  $: cheerio.CheerioAPI,
  finalUrl: string
): GoogleResponseType {
  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase()

  // 检测挑战页面
  const challengeKeywords = [
    'verifying your request',
    'unusual traffic from your computer network',
    'our systems have detected unusual traffic',
    'sorry',
    'recaptcha',
  ]
  if (challengeKeywords.some((kw) => bodyText.includes(kw))) {
    return 'CHALLENGE'
  }
  if (finalUrl.includes('/sorry/')) {
    return 'CHALLENGE'
  }

  // 检测 Consent 页面
  if (finalUrl.includes('consent.google.com')) {
    return 'CONSENT'
  }
  if (
    bodyText.includes('before you continue to google') &&
    (bodyText.includes('consent') || bodyText.includes('privacy') || bodyText.includes('cookie'))
  ) {
    return 'CONSENT'
  }

  // 检测是否包含搜索结果的典型特征
  const h3Count = $('h3').length
  if (h3Count > 0) return 'NORMAL_SERP'

  return 'UNKNOWN'
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

/** 尝试从 h3 元素出发找到一个结果条目（title + url） */
function tryExtractFromH3(
  $: cheerio.CheerioAPI,
  $h3: cheerio.Cheerio<cheerio.Element>,
  seenUrls: Set<string>
): { title: string; url: string; snippet: string } | null {
  const title = $h3.text().replace(/\s+/g, ' ').trim()
  if (!title) return null

  // 策略 1: h3 自身在 a 内
  let $anchor = $h3.closest('a[href]')
  // 策略 2: 向上查找包含 h3 的 a
  if (!$anchor.length) {
    $anchor = $h3.parents('a[href]').first()
  }
  // 策略 3: 在父容器中找主链接
  if (!$anchor.length) {
    const container = $h3.closest('div')
    $anchor = container.find('a[href]').filter((_i, el) => {
      const $el = $(el)
      return $el.find('h3').length > 0 || $el.text().includes(title)
    }).first()
  }
  // 策略 4: 在父容器中找 .yuRUbf a
  if (!$anchor.length) {
    $anchor = $h3.closest('div').find('.yuRUbf a[href]').first()
  }

  if (!$anchor.length) return null

  const href = $anchor.attr('href')
  if (!href) return null

  const url = extractRealUrl(href)
  if (!url) return null
  if (isGoogleInternalUrl(url)) return null
  if (isGoogleNavigationUrl(url)) return null
  if (seenUrls.has(url)) return null

  return { title, url, snippet: '' }
}

/** 从结果容器中提取 snippet */
function extractSnippet($: cheerio.CheerioAPI, $container: cheerio.Cheerio<cheerio.AnyNode>): string {
  const snippetSelectors = ['.VwiC3b', '.s3v9rd', '.ITZIwc', '[data-sncf]', '.st']
  for (const sel of snippetSelectors) {
    const $el = $container.find(sel).first()
    if ($el.length) {
      const text = $el.text().replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return ''
}

/** 检查容器是否为广告 */
function isAdContainer($: cheerio.CheerioAPI, $container: cheerio.Cheerio<cheerio.AnyNode>): boolean {
  const text = $container.text().toLowerCase()
  return text.includes('sponsored') || text.includes('广告')
}

/** 多策略解析正常 SERP */
function parseNormalSerp(
  $: cheerio.CheerioAPI
): { results: SearchResultItem[]; debug: Record<string, number> } {
  const results: SearchResultItem[] = []
  const seenUrls = new Set<string>()

  const debug = {
    h3Count: $('h3').length,
    linkCount: $('a[href]').length,
    tF2CxcCount: $('div.tF2Cxc').length,
    gCount: $('div.g').length,
    MjjYudCount: $('div.MjjYud').length,
    VwiC3bCount: $('.VwiC3b').length,
  }

  // 策略 1: div.tF2Cxc（经典桌面 SERP 结果容器）
  const $tf2cxc = $('div.tF2Cxc')
  $tf2cxc.each((_i, el) => {
    if (results.length >= MAX_RESULTS) return false
    const $container = $(el)
    if (isAdContainer($, $container)) return

    const $h3 = $container.find('h3').first()
    if (!$h3.length) return
    const item = tryExtractFromH3($, $h3, seenUrls)
    if (!item) return

    seenUrls.add(item.url)
    item.snippet = extractSnippet($, $container)
    results.push({ index: results.length + 1, ...item })
  })

  // 策略 2: div.g（传统 Google 结果容器）
  if (results.length === 0) {
    $('div.g').each((_i, el) => {
      if (results.length >= MAX_RESULTS) return false
      const $container = $(el)
      if (isAdContainer($, $container)) return

      const $h3 = $container.find('h3').first()
      if (!$h3.length) return
      const item = tryExtractFromH3($, $h3, seenUrls)
      if (!item) return

      seenUrls.add(item.url)
      item.snippet = extractSnippet($, $container)
      results.push({ index: results.length + 1, ...item })
    })
  }

  // 策略 3: div.MjjYud
  if (results.length === 0) {
    $('div.MjjYud').each((_i, el) => {
      if (results.length >= MAX_RESULTS) return false
      const $container = $(el)
      if (isAdContainer($, $container)) return

      const $h3 = $container.find('h3').first()
      if (!$h3.length) return
      const item = tryExtractFromH3($, $h3, seenUrls)
      if (!item) return

      seenUrls.add(item.url)
      item.snippet = extractSnippet($, $container)
      results.push({ index: results.length + 1, ...item })
    })
  }

  // 策略 4: 以 h3 为锚点反向查找
  if (results.length === 0) {
    $('h3').each((_i, el) => {
      if (results.length >= MAX_RESULTS) return false
      const $h3 = $(el)
      const item = tryExtractFromH3($, $h3, seenUrls)
      if (!item) return

      // 尝试从 h3 的父容器中提取 snippet
      const $container = $h3.closest('div')
      if ($container.length) {
        item.snippet = extractSnippet($, $container)
      }

      seenUrls.add(item.url)
      results.push({ index: results.length + 1, ...item })
    })
  }

  return { results, debug }
}

export class GoogleHtmlSearchEngine implements SearchEngine {
  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const url = new URL(GOOGLE_SEARCH_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('hl', 'zh-CN')
    const urlStr = url.toString()

    console.log('[WebSearch] engine=google query=', query)
    const { html, finalUrl } = await this.fetchHtml(urlStr, signal)
    return this.parseResults(html, finalUrl)
  }

  private fetchHtml(url: string, signal?: AbortSignal): Promise<{ html: string; finalUrl: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const headers: Record<string, string> = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
      }

      let finalUrl = url

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
          if (res.statusCode === 429) {
            cleanup()
            console.log('[GoogleSearch Response] status=429')
            reject(new Error('SEARCH_RATE_LIMITED: Google returned 429'))
            return
          }

          if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location
            if (location) {
              const redirected = new URL(location, url).toString()
              finalUrl = redirected
              cleanup()
              resolve(this.fetchHtml(redirected, signal))
            } else {
              reject(new Error(`Google search redirect without location (${res.statusCode})`))
            }
            return
          }

          if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) {
            // 如果响应 URL 与请求 URL 不同，记录最终 URL
            if (res.headers.location) {
              finalUrl = new URL(res.headers.location, url).toString()
            }

            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              cleanup()
              const html = Buffer.concat(chunks).toString('utf8')
              console.log(
                '[GoogleSearch Response] status=%d contentType=%s finalUrl=%s bodyLength=%d',
                res.statusCode,
                res.headers['content-type'] || 'unknown',
                finalUrl,
                html.length
              )
              resolve({ html, finalUrl })
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

  private parseResults(html: string, finalUrl: string): SearchResultItem[] {
    const $ = cheerio.load(html)

    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim()
    const responseType = detectGoogleResponseType($, finalUrl)

    console.log(
      '[GoogleSearch Parser] title=%s responseType=%s',
      pageTitle.slice(0, 80),
      responseType
    )

    // 打印 body 前 500 字符用于诊断
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 500)
    console.log('[GoogleSearch Parser] bodyPrefix=%s', bodyText)

    switch (responseType) {
      case 'CHALLENGE':
        console.log('[WebSearch] engine=google error=google_challenge')
        throw new Error(
          'SEARCH_PROVIDER_CHALLENGE: Google 要求验证当前网络请求，请更换网络/代理出口或切换其他搜索引擎。'
        )
      case 'CONSENT':
        console.log('[WebSearch] engine=google error=google_consent')
        throw new Error(
          'SEARCH_PROVIDER_CONSENT_REQUIRED: Google 需要同意隐私条款，请在浏览器中访问 google.com 完成同意。'
        )
      case 'RATE_LIMITED':
        throw new Error('SEARCH_RATE_LIMITED: Google returned 429')
      case 'UNKNOWN':
        // 没有 h3，也不是 challenge/consent — 可能是空 SERP
        break
      case 'NORMAL_SERP':
        break
    }

    // 多策略解析
    const { results, debug } = parseNormalSerp($)

    console.log(
      '[GoogleSearch Parser] h3Count=%d linkCount=%d tF2CxcCount=%d gCount=%d MjjYudCount=%d VwiC3bCount=%d parsedResults=%d',
      debug.h3Count,
      debug.linkCount,
      debug.tF2CxcCount,
      debug.gCount,
      debug.MjjYudCount,
      debug.VwiC3bCount,
      results.length
    )

    if (results.length === 0) {
      // 有 h3 但解析不到结果 vs 真的没有结果
      if (debug.h3Count > 0) {
        throw new Error(
          'SEARCH_NO_ORGANIC_RESULTS: Google 页面存在但无法解析出普通搜索结果（可能为天气卡片/AI Overview/Knowledge Panel 等特殊页面）'
        )
      }
      throw new Error('SEARCH_INVALID_RESPONSE: Google search returned no parseable results')
    }

    console.log('[WebSearch] engine=google parsedResults=', results.length)
    return results
  }
}