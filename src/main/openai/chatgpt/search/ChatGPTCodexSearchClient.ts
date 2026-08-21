import * as https from 'https'
import type { IncomingMessage } from 'http'
import type { OAuthCredentialManager } from '../auth/OAuthCredentialManager'
import { getProxyAgent } from '../httpsClient'
import { logNon2xxResponse } from '../rateLimitDiagnostics'
import type { SearchRequest, SearchResponse } from '../../../../shared/types/webSearch'

const BASE_URL = 'https://chatgpt.com'

export class WebSearchError extends Error {
  code: string
  status: number | null
  retryAfter: string | null

  constructor(code: string, message: string, status: number | null = null, retryAfter: string | null = null) {
    super(message)
    this.name = 'WebSearchError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

export class ChatGPTCodexSearchClient {
  private credentialManager: OAuthCredentialManager

  constructor(credentialManager: OAuthCredentialManager) {
    this.credentialManager = credentialManager
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const token = await this.credentialManager.getAccessToken()
    const accountId = await this.credentialManager.getAccountId()

    const url = `${BASE_URL}/backend-api/codex/alpha/search`

    const body = JSON.stringify(request)

    console.log('[ChatGPT Request]')
    console.log('endpoint=POST', url)
    console.log('model=', request.model)
    console.log('id=', request.id)
    console.log('input=', typeof request.input === 'string' ? request.input.slice(0, 200) : '(items)')

    try {
      const response = await this.doRequest(url, token, accountId, body, signal)
      if (response.status === 401) {
        // 刷新 token 后重试一次
        await this.credentialManager.handleUnauthorized()
        const retryToken = await this.credentialManager.getAccessToken()
        const retryAccountId = await this.credentialManager.getAccountId()
        const retryResponse = await this.doRequest(url, retryToken, retryAccountId, body, signal)
        return this.parseResponse(url, retryResponse)
      }
      return this.parseResponse(url, response)
    } catch (err) {
      if (err instanceof WebSearchError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WebSearchError('ABORTED', 'Search aborted')
      }
      if (signal?.aborted) {
        throw new WebSearchError('ABORTED', 'Search aborted')
      }
      throw new WebSearchError('WEB_SEARCH_NETWORK_ERROR', err instanceof Error ? err.message : String(err))
    }
  }

  private parseResponse(url: string, response: { status: number; headers: IncomingMessage['headers']; text: string }): SearchResponse {
    if (response.status >= 200 && response.status < 300) {
      let data: SearchResponse
      try {
        data = JSON.parse(response.text) as SearchResponse
      } catch {
        throw new WebSearchError('WEB_SEARCH_UPSTREAM_ERROR', 'Invalid JSON from search endpoint', response.status)
      }
      console.log('[WebSearch Response] top-level keys:', Object.keys(data).join(', '))
      console.log('[WebSearch Response] results count:', data.results?.length ?? 0)
      if (data.output) {
        console.log('[WebSearch Response] output (truncated):', data.output.slice(0, 300))
      }
      return data
    }

    if (response.status === 401) {
      throw new WebSearchError('UNAUTHORIZED', 'Unauthorized', response.status)
    }

    if (response.status === 403) {
      const contentType = String(response.headers['content-type'] ?? '')
      const bodyText = response.text
      logNon2xxResponse('POST ' + url, 'POST', response.status, response.headers, response.text)
      if (contentType.includes('text/html') || bodyText.includes('Enable JavaScript and cookies')) {
        throw new WebSearchError('UPSTREAM_CHALLENGE', '网页搜索被上游安全验证拦截，请检查代理或稍后重试。', response.status)
      }
      throw new WebSearchError('UPSTREAM_CHALLENGE', '网页搜索被上游拒绝（403）。', response.status)
    }

    if (response.status === 429) {
      const retryAfter = String(response.headers['retry-after'] ?? '')
      logNon2xxResponse('POST ' + url, 'POST', response.status, response.headers, response.text)
      throw new WebSearchError('WEB_SEARCH_RATE_LIMITED', '搜索请求过于频繁，请稍后重试。', response.status, retryAfter || null)
    }

    if (response.status >= 500) {
      logNon2xxResponse('POST ' + url, 'POST', response.status, response.headers, response.text)
      throw new WebSearchError('WEB_SEARCH_UPSTREAM_ERROR', '搜索服务暂时不可用。', response.status)
    }

    logNon2xxResponse('POST ' + url, 'POST', response.status, response.headers, response.text)

    throw new WebSearchError('WEB_SEARCH_UPSTREAM_ERROR', `搜索请求失败（${response.status}）。`, response.status)
  }

  private doRequest(
    url: string,
    token: string,
    accountId: string | null,
    body: string,
    signal?: AbortSignal
  ): Promise<{ status: number; headers: IncomingMessage['headers']; text: string }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId
      }

      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers,
          agent: getProxyAgent(),
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            console.log('[ChatGPT Request] status=', res.statusCode)
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: data,
            })
          })
        }
      )

      let abortHandler: (() => void) | null = null
      if (signal) {
        abortHandler = () => {
          req.destroy(new Error('Aborted'))
          reject(new WebSearchError('ABORTED', 'Search aborted'))
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      req.on('error', (err) => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
        }
        reject(err)
      })

      req.write(body)
      req.end()
    })
  }
}
