import { shell } from 'electron'
import type { OAuthClient } from './OAuthClient'
import type { OAuthCredential } from './OAuthCredentialStore'
import { generatePKCEParams } from './pkce'
import { OAuthCallbackServer } from './OAuthCallbackServer'
import { httpsRequest } from '../httpsClient'

const OAUTH_ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

/**
 * OpenAI ChatGPT OAuth client
 * 使用 Authorization Code + PKCE S256 flow
 */
export class OpenAIOAuthClient implements OAuthClient {
  private callbackServer: OAuthCallbackServer

  constructor() {
    this.callbackServer = new OAuthCallbackServer()
  }

  async login(): Promise<OAuthCredential> {
    const pkce = generatePKCEParams()

    // 构建 authorize URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'openchat',
    })

    const authUrl = `${OAUTH_ISSUER}/oauth/authorize?${params.toString()}`

    // 打开浏览器
    shell.openExternal(authUrl)

    // 启动回调服务器等待
    const result = await this.callbackServer.start(pkce.state)

    // 用 code 交换 token
    return this.exchangeCodeForTokens(result.code, pkce.codeVerifier)
  }

  async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: CLIENT_ID,
    }).toString()

    const response = await this.postForm('/oauth/token', body)

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`)
    }

    return this.parseTokenResponse(response.json<Record<string, unknown>>(), credential.refreshToken)
  }

  async logout(credential: OAuthCredential): Promise<void> {
    try {
      const body = new URLSearchParams({
        token: credential.refreshToken,
        client_id: CLIENT_ID,
      }).toString()

      await this.postForm('/oauth/revoke', body)
    } catch {
      // 最佳努力，忽略失败
    }
  }

  private async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthCredential> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }).toString()

    const response = await this.postForm('/oauth/token', body)

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`)
    }

    return this.parseTokenResponse(response.json<Record<string, unknown>>(), '')
  }

  private postForm(path: string, body: string) {
    const url = new URL(path, OAUTH_ISSUER)
    return httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      },
      'POST',
      body
    )
  }

  private parseTokenResponse(data: Record<string, unknown>, fallbackRefreshToken: string): OAuthCredential {
    const accessToken = String(data.access_token ?? '')
    const refreshToken = String(data.refresh_token ?? fallbackRefreshToken)
    const expiresIn = Number(data.expires_in ?? 3600)
    const accountId = this.extractAccountId(accessToken)

    // 从 ID Token 提取用户信息
    const idToken = String(data.id_token ?? '')
    const { email, planType, userId } = this.extractIdTokenClaims(idToken)

    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      accountId,
      email,
      planType,
      userId,
    }
  }

  /**
   * 从 access token JWT payload 中读取 account id
   * claim: https://api.openai.com/auth → chatgpt_account_id
   */
  private extractAccountId(accessToken: string): string {
    try {
      const parts = accessToken.split('.')
      if (parts.length < 2) return ''
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
      const authClaim = payload['https://api.openai.com/auth']
      return authClaim?.chatgpt_account_id ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 从 ID Token 提取 email、planType、userId
   */
  private extractIdTokenClaims(idToken: string): { email: string; planType: string; userId: string } {
    try {
      if (!idToken) return { email: '', planType: '', userId: '' }
      const parts = idToken.split('.')
      if (parts.length < 2) return { email: '', planType: '', userId: '' }
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))

      const email = (payload.profile?.email ?? payload.email ?? '') as string
      const authClaim = payload['https://api.openai.com/auth']
      const planType = (authClaim?.chatgpt_plan_type ?? '') as string
      const userId = (authClaim?.chatgpt_user_id ?? '') as string

      return { email, planType, userId }
    } catch {
      return { email: '', planType: '', userId: '' }
    }
  }
}
