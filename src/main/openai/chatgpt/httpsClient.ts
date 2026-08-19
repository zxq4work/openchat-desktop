import * as https from 'https'
import * as http from 'http'
import type { IncomingMessage } from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'

/**
 * 从环境变量读取代理地址
 * 优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy > ALL_PROXY > all_proxy
 * 例：HTTPS_PROXY=http://127.0.0.1:7890 npm run dev
 */
export function getProxyUrl(): string | null {
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
 * 返回可复用的代理 Agent（无代理时返回 undefined）
 */
let proxyLogged = false

export function getProxyAgent(): HttpsProxyAgent | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyLogged) {
    proxyLogged = true
    if (proxyUrl) {
      console.log('[httpsClient] Using proxy:', proxyUrl)
    } else {
      console.log('[httpsClient] No proxy configured (set HTTPS_PROXY env var)')
    }
  }
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
}

export interface HttpsResponse {
  status: number
  ok: boolean
  text: string
  json<T = unknown>(): T
}

/**
 * 代理感知的 HTTPS 请求（缓冲整个响应体）
 * 用于非流式场景：OAuth token 交换、refresh、revoke、models 列表
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
 * 返回原始 IncomingMessage，由调用方逐 chunk 读取（用于 SSE 流）
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
