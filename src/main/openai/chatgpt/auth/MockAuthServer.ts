import * as http from 'http'
import * as crypto from 'crypto'
import { computeCodeChallenge } from './pkce'

/**
 * Mock OAuth Authorization Server
 * 本地 HTTP 服务器，用于测试完整 OAuth 流程（PKCE + state + callback + token exchange）
 * 不连接 OpenAI
 */
export class MockAuthServer {
  private server: http.Server | null = null
  private port: number = 0
  private codeChallenges = new Map<string, string>() // state → code_challenge

  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
        this.handleRequest(req, res, url)
      })

      this.server.on('error', reject)

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number }
        this.port = addr.port
        resolve(this.port)
      })
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (url.pathname === '/oauth/authorize') {
      this.handleAuthorize(req, res, url)
    } else if (url.pathname === '/oauth/token') {
      this.handleToken(req, res)
    } else {
      res.writeHead(404)
      res.end()
    }
  }

  private handleAuthorize(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const clientId = url.searchParams.get('client_id')
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const codeChallenge = url.searchParams.get('code_challenge')

    if (!clientId || !redirectUri || !state) {
      res.writeHead(400)
      res.end('Missing required params')
      return
    }

    if (codeChallenge) {
      this.codeChallenges.set(state, codeChallenge)
    }

    // 模拟重定向
    const redirect = new URL(redirectUri)
    redirect.searchParams.set('code', 'mock-auth-code')
    redirect.searchParams.set('state', state)

    res.writeHead(302, { Location: redirect.toString() })
    res.end()
  }

  private handleToken(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const params = new URLSearchParams(body)
      const grantType = params.get('grant_type')
      const codeVerifier = params.get('code_verifier')
      const state = params.get('state')

      if (grantType === 'authorization_code') {
        // 验证 PKCE
        if (codeVerifier && state) {
          const expectedChallenge = this.codeChallenges.get(state)
          if (expectedChallenge) {
            const actualChallenge = computeCodeChallenge(codeVerifier)
            if (actualChallenge !== expectedChallenge) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code_verifier mismatch' }))
              return
            }
          }
        }

        const payload = {
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_mock_test',
          },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }

        const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
        const bodyPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
        const accessToken = `${header}.${bodyPayload}.mock_sig`

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }))
      } else if (grantType === 'refresh_token') {
        const payload = {
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_mock_test',
          },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }

        const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
        const bodyPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
        const accessToken = `${header}.${bodyPayload}.mock_sig`

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'mock-refresh-token-rotated',
          expires_in: 3600,
          token_type: 'Bearer',
        }))
      } else {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
      }
    })
  }
}