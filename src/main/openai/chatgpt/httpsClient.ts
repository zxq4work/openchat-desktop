import * as https from 'https'
import * as http from 'http'
import type { IncomingMessage } from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { ProxyConfig } from '../../../shared/types/settings'

// Dynamic import for socks-proxy-agent (optional dependency)
let SocksProxyAgent: (new (url: string) => unknown) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const socks = require('socks-proxy-agent')
  SocksProxyAgent = socks.SocksProxyAgent
} catch {
  // socks-proxy-agent not installed
}

/**
 * 持久化的代理配置（来自系统设置），优先级高于环境变量
 */
let persistedProxyConfig: ProxyConfig | null = null

export function setProxyConfig(config: ProxyConfig | null): void {
  persistedProxyConfig = config
  proxyAgentCache = undefined
  proxyLogged = false
}

export function getProxyConfig(): ProxyConfig | null {
  return persistedProxyConfig
}

function buildProxyUrlFromConfig(config: ProxyConfig): string {
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
    : ''
  // socks5h: 让代理服务器端解析 DNS，避免客户端解析出 IP 后导致 TLS 证书主机名不匹配
  const scheme = config.protocol === 'socks5' ? 'socks5h' : config.protocol
  return `${scheme}://${auth}${config.host}:${config.port}`
}

/**
 * 获取代理 URL，优先级：持久化配置 > 环境变量
 */
export function getProxyUrl(): string | null {
  // 持久化配置存在时，以其为准，不再回退到环境变量
  if (persistedProxyConfig) {
    return persistedProxyConfig.enabled
      ? buildProxyUrlFromConfig(persistedProxyConfig)
      : null
  }

  // 无持久化配置时，从环境变量读取
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null
  )
}

/**
 * 返回代理 Agent（无代理时返回 undefined）
 */
let proxyLogged = false
let proxyAgentCache: HttpsProxyAgent | undefined

function createAgent(proxyUrl: string): HttpsProxyAgent {
  if (SocksProxyAgent && (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks5h://'))) {
    return new SocksProxyAgent(proxyUrl) as unknown as HttpsProxyAgent
  }
  return new HttpsProxyAgent(proxyUrl)
}

export function getProxyAgent(): HttpsProxyAgent | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl) {
    if (!proxyLogged) {
      proxyLogged = true
      proxyAgentCache = undefined
      console.log('[httpsClient] No proxy configured')
    }
    return undefined
  }

  if (!proxyLogged) {
    proxyLogged = true
    console.log('[httpsClient] Using proxy:', proxyUrl)
  }

  if (!proxyAgentCache) {
    proxyAgentCache = createAgent(proxyUrl)
  }
  return proxyAgentCache
}

// 判断主机名是否为局域网/本地地址，这些地址不应走代理
function isPrivateOrLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true
  }
  if (hostname.endsWith('.local')) {
    return true
  }
  // 私有 IPv4 网段
  const parts = hostname.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = parseInt(parts[0], 10)
    const b = parseInt(parts[1], 10)
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
  }
  return false
}

/**
 * 获取代理 Agent，但对局域网/本地地址跳过代理
 * 自定义模型服务常部署在局域网，走代理会导致连接失败
 */
export function getProxyAgentForHost(hostname: string): HttpsProxyAgent | undefined {
  if (isPrivateOrLocalHost(hostname)) {
    return undefined
  }
  return getProxyAgent()
}

export interface HttpsResponse {
  status: number
  ok: boolean
  text: string
  json<T = unknown>(): T
}

/**
 * 代理感知的 HTTPS 请求（缓冲整个响应体）
 */
export function httpsRequest(
  options: https.RequestOptions & { hostname: string },
  method: 'GET' | 'POST' = 'GET',
  body?: string
): Promise<HttpsResponse> {
  return new Promise<HttpsResponse>((resolve, reject) => {
    const req = https.request(
      {
        ...options,
        method,
        agent: getProxyAgent(),
        headers: {
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...options.headers,
        },
      },
      (res: IncomingMessage) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString()
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            ok: res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300,
            text: data,
            json<T = unknown>() {
              return JSON.parse(data) as T
            },
          })
        })
      }
    )

    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 代理感知的 HTTPS 流式请求
 */
export function httpsStreamRequest(
  options: https.RequestOptions & { hostname: string },
  method: 'GET' | 'POST' = 'POST',
  body?: string
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = https.request(
      {
        ...options,
        method,
        agent: getProxyAgent(),
        headers: {
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...options.headers,
        },
      },
      (res: IncomingMessage) => {
        resolve(res)
      }
    )

    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export { http }