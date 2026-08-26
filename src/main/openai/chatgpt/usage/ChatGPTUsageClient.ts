import type { IncomingMessage } from 'http'
import type { OAuthCredentialManager } from '../auth/OAuthCredentialManager'
import { createRequest } from '../httpsClient'
import type { ChatGPTUsageResponse } from '../../../../shared/types/usage'

const BASE_URL = 'https://chatgpt.com'

/**
 * 负责 GET /backend-api/wham/usage
 * 仅做 HTTP 请求，不做缓存 / 业务判断。
 * 401 时刷新 token 后重试一次。
 */
export class ChatGPTUsageClient {
  private credentialManager: OAuthCredentialManager

  constructor(credentialManager: OAuthCredentialManager) {
    this.credentialManager = credentialManager
  }

  async getUsage(signal?: AbortSignal): Promise<ChatGPTUsageResponse> {
    const token = await this.credentialManager.getAccessToken()
    const accountId = await this.credentialManager.getAccountId()

    const url = `${BASE_URL}/backend-api/wham/usage`

    try {
      const response = await this.doRequest(url, token, accountId, signal)
      if (response.status === 401) {
        await this.credentialManager.handleUnauthorized()
        const retryToken = await this.credentialManager.getAccessToken()
        const retryAccountId = await this.credentialManager.getAccountId()
        const retryResponse = await this.doRequest(url, retryToken, retryAccountId, signal)
        return this.parseResponse(url, retryResponse)
      }
      return this.parseResponse(url, response)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err
      }
      if (signal?.aborted) {
        throw new Error('Aborted')
      }
      throw err
    }
  }

  private parseResponse(
    _url: string,
    response: { status: number; headers: IncomingMessage['headers']; text: string }
  ): ChatGPTUsageResponse {
    if (response.status >= 200 && response.status < 300) {
      let data: ChatGPTUsageResponse
      try {
        data = JSON.parse(response.text) as ChatGPTUsageResponse
      } catch {
        throw new Error('Invalid JSON from usage endpoint')
      }
      return data
    }

    if (response.status === 401) {
      throw new Error('Unauthorized from usage endpoint')
    }

    throw new Error(`Usage endpoint returned ${response.status}`)
  }

  private doRequest(
    url: string,
    token: string,
    accountId: string | null,
    signal?: AbortSignal
  ): Promise<{ status: number; headers: IncomingMessage['headers']; text: string }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      }
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId
      }

      const request = createRequest(
        {
          hostname: parsedUrl.hostname,
          port: 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers,
          protocol: 'https:',
        },
        (res: IncomingMessage) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            cleanup()
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
        if (signal.aborted) {
          reject(new Error('Aborted'))
          return
        }
        abortHandler = () => {
          request.destroy(new Error('Aborted'))
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

      request.on('error', (err) => {
        cleanup()
        reject(err)
      })

      request.end()
    })
  }
}
