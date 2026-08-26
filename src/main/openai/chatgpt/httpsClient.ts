import * as https from 'https'
import * as http from 'http'
import type { IncomingMessage } from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { net, session } from 'electron'
import type { ProxyConfig, ProxyMode } from '../../../shared/types/settings'

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

/**
 * 获取当前代理模式
 */
export function getProxyMode(): ProxyMode {
  if (!persistedProxyConfig) return 'direct'
  if (persistedProxyConfig.mode) return persistedProxyConfig.mode
  // 向后兼容：旧配置中 enabled=false 对应 direct，enabled=true 根据 protocol 推断
  if (!persistedProxyConfig.enabled) return 'direct'
  return persistedProxyConfig.protocol === 'socks5' ? 'socks5' : 'http'
}

/**
 * 归一化代理模式并更新持久化配置
 */
export function setProxyMode(mode: ProxyMode): void {
  if (!persistedProxyConfig) {
    persistedProxyConfig = {
      enabled: mode !== 'direct',
      protocol: mode === 'socks5' ? 'socks5' : 'http',
      host: '127.0.0.1',
      port: '',
      username: '',
      password: '',
      mode,
    }
  } else {
    persistedProxyConfig.mode = mode
    persistedProxyConfig.enabled = mode !== 'direct'
    if (mode === 'socks5') {
      persistedProxyConfig.protocol = 'socks5'
    } else if (mode === 'http') {
      persistedProxyConfig.protocol = 'http'
    }
  }
  proxyAgentCache = undefined
  proxyLogged = false
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
    if (getProxyMode() === 'system') return null
    if (!persistedProxyConfig.enabled) return null
    return buildProxyUrlFromConfig(persistedProxyConfig)
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
  // system 模式不使用 agent
  if (getProxyMode() === 'system') return undefined

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
 */
export function getProxyAgentForHost(hostname: string): HttpsProxyAgent | undefined {
  if (getProxyMode() === 'system') return undefined
  if (isPrivateOrLocalHost(hostname)) {
    return undefined
  }
  return getProxyAgent()
}

// ─── Electron net.request 集成 ────────────────────────────────────────

/**
 * 与 Node https.ClientRequest 兼容的最小接口。
 */
export interface UnifiedClientRequest {
  write: (chunk: string | Buffer) => void
  end: () => void
  destroy: (err?: Error) => void
  on(event: 'error', handler: (err: Error) => void): void
  on(event: 'timeout', handler: () => void): void
  on(event: string, handler: (...args: any[]) => void): void
}

function buildRequestUrl(options: UnifiedRequestOptions): string {
  const protocol = options.protocol || 'https:'
  const defaultPort = options.port || (protocol === 'http:' ? 80 : 443)
  return `${protocol}//${options.hostname}:${defaultPort}${options.path || ''}`
}

/**
 * Headers forbidden by Electron/Chromium net.request.
 * Chromium manages these automatically; setting them manually causes ERR_INVALID_ARGUMENT.
 */
const ELECTRON_RESTRICTED_HEADERS = new Set([
  'content-length',
  'host',
  'trailer',
  'te',
  'upgrade',
  'cookie2',
  'keep-alive',
  'transfer-encoding',
])

function sanitizeElectronRequestHeaders(
  headers: Record<string, string>
): { sanitized: Record<string, string>; removed: string[] } {
  const sanitized: Record<string, string> = {}
  const removed: string[] = []

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()

    if (ELECTRON_RESTRICTED_HEADERS.has(lower)) {
      removed.push(name)
      continue
    }

    if (lower === 'connection' && value.toLowerCase().includes('upgrade')) {
      removed.push(name)
      continue
    }

    sanitized[name] = value
  }

  return { sanitized, removed }
}

/**
 * 将 Electron net.request 包装成与 Node https.request 兼容的接口。
 */
function electronRequest(
  options: UnifiedRequestOptions,
  callback: (res: IncomingMessage) => void
): UnifiedClientRequest {
  const url = buildRequestUrl(options)

  const { sanitized: headers, removed } = sanitizeElectronRequestHeaders(options.headers || {})

  console.log('[ElectronNetTransport] method=%s url=%s', options.method || 'GET', url)
  console.log('[ElectronNetTransport] headers=%s', Object.keys(headers).join(','))

  if (removed.length > 0) {
    console.log('[ElectronNetTransport] removedRestrictedHeaders=%s', removed.join(','))
  }

  const req = net.request({
    method: options.method || 'GET',
    url,
    session: session.defaultSession,
  })

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      req.setHeader(key, String(value))
    }
  }

  const errorHandlers: Array<(err: Error) => void> = []
  const timeoutHandlers: Array<() => void> = []
  let destroyed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  const fireError = (err: Error) => {
    for (const h of errorHandlers) h(err)
  }

  // Electron ClientRequest 在连接/协议层错误时触发 error（response 尚未触发）
  req.on('error', (err: Error) => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    fireError(err)
  })

  req.on('response', (electronRes) => {
    // Electron IncomingMessage 兼容 Node IncomingMessage（statusCode/headers/data/end/error）
    callback(electronRes as unknown as IncomingMessage)
  })

  if (options.timeout && options.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      timeoutTimer = null
      if (destroyed) return
      for (const h of timeoutHandlers) h()
    }, options.timeout)
  }

  return {
    write(chunk: string | Buffer) {
      if (!destroyed) req.write(chunk)
    },
    end() {
      if (!destroyed) {
        destroyed = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        req.end()
      }
    },
    destroy(err?: Error) {
      if (destroyed) return
      destroyed = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (err) fireError(err)
      req.abort()
    },
    on(event: string, handler: (...args: any[]) => void) {
      if (event === 'error') {
        errorHandlers.push(handler as (err: Error) => void)
      } else if (event === 'timeout') {
        timeoutHandlers.push(handler as () => void)
      }
    },
  }
}

// ─── 统一的请求创建 ──────────────────────────────────────────────────

export interface UnifiedRequestOptions {
  hostname: string
  port?: number
  path: string
  method: string
  headers: Record<string, string>
  protocol?: string  // 'http:' or 'https:'
  timeout?: number
  bypassLocal?: boolean  // 对局域网/本地地址跳过代理（自定义 Provider 常部署在局域网）
}

/**
 * 创建统一网络请求，根据代理模式自动选择 transport。
 *
 * - system 模式：使用 Electron net.request（Chromium 网络栈，系统代理）
 * - direct/http/socks5 模式：使用 Node https/http.request + 代理 agent
 *
 * 返回对象兼容 Node https.ClientRequest 的核心方法：
 * write, end, destroy, on('error'), on('timeout')
 * callback 接收 IncomingMessage-like 对象。
 */
export function createRequest(
  options: UnifiedRequestOptions,
  callback: (res: IncomingMessage) => void
): UnifiedClientRequest {
  const mode = getProxyMode()

  if (mode === 'system') {
    const url = buildRequestUrl(options)
    console.log('[Proxy] mode=system url=', url)
    // 诊断：打印 Chromium 对目标 URL 的实际代理路由决策（DIRECT / PROXY / SOCKS5）
    session.defaultSession
      .resolveProxy(url)
      .then((route) => console.log('[Proxy Resolve] url=%s route=%s', url, route))
      .catch(() => console.log('[Proxy Resolve] url=%s route=ERROR', url))
    return electronRequest(options, callback)
  }

  const isHttps = options.protocol !== 'http:'
  const lib = isHttps ? https : http
  const defaultPort = options.port || (isHttps ? 443 : 80)

  const req = lib.request(
    {
      hostname: options.hostname,
      port: options.port || defaultPort,
      path: options.path,
      method: options.method,
      headers: options.headers,
      agent: options.bypassLocal ? getProxyAgentForHost(options.hostname) : getProxyAgent(),
      ...(options.timeout ? { timeout: options.timeout } : {}),
    },
    callback
  )

  return {
    write(chunk: string | Buffer) { req.write(chunk) },
    end() { req.end() },
    destroy(err?: Error) { req.destroy(err) },
    on(event: string, handler: (...args: any[]) => void) {
      req.on(event as string, handler as (...args: any[]) => void)
    },
  }
}

// ─── Electron Session Proxy 管理 ─────────────────────────────────────

/**
 * 将当前代理模式应用到 Electron session。
 * 必须在 app.whenReady() 之后调用。
 */
export async function applyProxyMode(): Promise<void> {
  const mode = getProxyMode()
  const ses = session.defaultSession

  switch (mode) {
    case 'system':
      console.log('[Proxy] applying mode=system')
      await ses.setProxy({ mode: 'system' })
      break
    case 'direct':
      console.log('[Proxy] applying mode=direct')
      await ses.setProxy({ mode: 'direct' })
      break
    default:
      // http/socks5: 固定代理模式，Chromium 侧设为 direct
      // 因为代理由 Node https.request + agent 处理
      console.log('[Proxy] applying mode=direct for fixed proxy (handled by Node agent)')
      await ses.setProxy({ mode: 'direct' })
      break
  }
}

/**
 * 刷新系统代理配置（仅在 system 模式下有意义）
 */
export async function forceReloadProxyConfig(): Promise<void> {
  if (getProxyMode() !== 'system') return
  await session.defaultSession.forceReloadProxyConfig()
  console.log('[Proxy] forceReloadProxyConfig done')
}

/**
 * 使用 Chromium 解析指定 URL 的代理路由。
 * 仅在 system 模式下返回有意义的结果。
 */
export async function resolveSystemProxy(url: string): Promise<string> {
  return session.defaultSession.resolveProxy(url)
}

/**
 * 关闭所有持久连接，代理切换后调用。
 */
export async function closeAllConnections(): Promise<void> {
  await session.defaultSession.closeAllConnections()
  console.log('[Proxy] closeAllConnections done')
}

// ─── 兼容旧接口 ──────────────────────────────────────────────────────

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
    const req = createRequest(
      {
        hostname: options.hostname,
        port: options.port ? Number(options.port) : undefined,
        path: (options.path || '') as string,
        method,
        headers: (options.headers || {}) as Record<string, string>,
        protocol: options.protocol as string | undefined,
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
    const req = createRequest(
      {
        hostname: options.hostname,
        port: options.port ? Number(options.port) : undefined,
        path: (options.path || '') as string,
        method,
        headers: (options.headers || {}) as Record<string, string>,
        protocol: options.protocol as string | undefined,
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