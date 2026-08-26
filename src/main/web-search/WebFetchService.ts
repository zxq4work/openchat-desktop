import * as dns from 'dns'
import type { IncomingMessage } from 'http'
import * as cheerio from 'cheerio'
import type { WebFetchResult } from '../../shared/types/provider'
import { createRequest } from '../openai/chatgpt/httpsClient'

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_CONTENT_CHARS = 12000

// 禁止访问的 IP 范围
const PRIVATE_IPV4_RANGES = [
  { start: ip4ToInt('0.0.0.0'), end: ip4ToInt('0.255.255.255') },
  { start: ip4ToInt('10.0.0.0'), end: ip4ToInt('10.255.255.255') },
  { start: ip4ToInt('127.0.0.0'), end: ip4ToInt('127.255.255.255') },
  { start: ip4ToInt('169.254.0.0'), end: ip4ToInt('169.254.255.255') },
  { start: ip4ToInt('172.16.0.0'), end: ip4ToInt('172.31.255.255') },
  { start: ip4ToInt('192.168.0.0'), end: ip4ToInt('192.168.255.255') },
]

function ip4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
}

function isPrivateIPv4(ip: string): boolean {
  // 仅处理合法 IPv4（四段十进制），IPv6 交给 isPrivateIPv6 判断
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return false
  }
  const num = ip4ToInt(ip)
  return PRIVATE_IPV4_RANGES.some((range) => num >= range.start && num <= range.end)
}

function isPrivateIPv6(ip: string): boolean {
  return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')
}

function isUnsafeHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    return true
  }
  if (hostname === '169.254.169.254') {
    return true
  }
  return false
}

async function resolveHostname(hostname: string): Promise<string[]> {
  try {
    const addresses = await dns.promises.resolve4(hostname)
    try {
      const ipv6 = await dns.promises.resolve6(hostname)
      console.log('[WebFetch DNS]', hostname, '→', [...addresses, ...ipv6].join(', '))
      return [...addresses, ...ipv6]
    } catch {
      console.log('[WebFetch DNS]', hostname, '→', addresses.join(', '))
      return addresses
    }
  } catch {
    throw new Error(`DNS resolution failed for ${hostname}`)
  }
}

function isSafeUrl(url: string): boolean {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  if (isUnsafeHostname(parsed.hostname)) {
    return false
  }
  return true
}

async function validateUrl(url: string): Promise<void> {
  if (!isSafeUrl(url)) {
    throw new Error('FETCH_UNSAFE_URL: URL is not allowed')
  }

  const parsed = new URL(url)
  const ips = await resolveHostname(parsed.hostname)

  for (const ip of ips) {
    if (isPrivateIPv4(ip) || isPrivateIPv6(ip)) {
      throw new Error('FETCH_UNSAFE_URL: URL resolves to private/internal IP')
    }
  }
}

export class WebFetchService {
  async fetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
    return this.fetchWithRedirects(url, signal, 0)
  }

  private async fetchWithRedirects(url: string, signal?: AbortSignal, redirectCount: number = 0): Promise<WebFetchResult> {
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error('FETCH_TOO_MANY_REDIRECTS: Exceeded maximum redirects')
    }

    await validateUrl(url)

    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'

    const response = await this.doRequest(url, isHttps, signal)

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const redirectUrl = new URL(response.headers.location, url).toString()
      return this.fetchWithRedirects(redirectUrl, signal, redirectCount + 1)
    }

    if (response.status !== 200) {
      throw new Error(`FETCH_NETWORK_ERROR: HTTP ${response.status}`)
    }

    const contentType = response.headers['content-type'] || ''
    if (
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('application/octet-stream')
    ) {
      throw new Error('FETCH_UNSUPPORTED_CONTENT: Content type not supported for text extraction')
    }

    const body = response.body
    if (body.length > MAX_BODY_BYTES) {
      throw new Error('FETCH_TOO_LARGE: Response body exceeds 2MB limit')
    }

    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')
    if (isHtml) {
      return this.extractFromHtml(url, body)
    }

    // 纯文本直接返回
    const truncated = body.length > MAX_CONTENT_CHARS
    return {
      url,
      title: '',
      content: body.slice(0, MAX_CONTENT_CHARS),
      truncated,
    }
  }

  private extractFromHtml(url: string, html: string): WebFetchResult {
    const $ = cheerio.load(html)

    // 删除不需要的元素
    $('script, style, noscript, svg, iframe').remove()

    const title = $('title').first().text().trim()

    // 优先选择 article, main, body
    let $content = $('article').first()
    if (!$content.length) {
      $content = $('main').first()
    }
    if (!$content.length) {
      $content = $('body')
    }

    const text = $content.text()
    const normalized = text.replace(/\s+/g, ' ').trim()
    const truncated = normalized.length > MAX_CONTENT_CHARS

    return {
      url,
      title,
      content: normalized.slice(0, MAX_CONTENT_CHARS),
      truncated,
    }
  }

  private doRequest(
    url: string,
    isHttps: boolean,
    signal?: AbortSignal
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)

      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : undefined,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          timeout: TIMEOUT_MS,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9',
          },
          protocol: isHttps ? 'https:' : 'http:',
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = []
          let totalSize = 0

          res.on('data', (chunk: Buffer) => {
            totalSize += chunk.length
            if (totalSize > MAX_BODY_BYTES) {
              res.destroy()
              cleanup()
              reject(new Error('FETCH_TOO_LARGE: Response body exceeds 2MB limit'))
              return
            }
            chunks.push(chunk)
          })

          res.on('end', () => {
            cleanup()
            const headers: Record<string, string> = {}
            if (res.headers) {
              for (const [k, v] of Object.entries(res.headers)) {
                if (v) headers[k] = Array.isArray(v) ? v[0] : v
              }
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        }
      )

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('FETCH_TIMEOUT: Request timed out'))
      })

      let abortHandler: (() => void) | null = null
      if (signal) {
        if (signal.aborted) {
          reject(new Error('Aborted'))
          return
        }
        abortHandler = () => {
          req.destroy()
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
}