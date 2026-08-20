import type { OAuthClient } from './OAuthClient'
import type { OAuthCredential } from './OAuthCredentialStore'

export type MockOAuthScenario =
  | 'success'
  | 'user_cancelled'
  | 'state_mismatch'
  | 'callback_timeout'
  | 'token_exchange_400'
  | 'refresh_success'
  | 'refresh_invalid_grant'
  | 'expired_access_token'
  | '401_refresh_retry_success'
  | '401_refresh_retry_failed'

/**
 * Mock OAuth Client — 不访问互联网
 * 用于测试和开发环境
 */
export class MockOAuthClient implements OAuthClient {
  private scenario: MockOAuthScenario
  private refreshCount = 0

  constructor(scenario: MockOAuthScenario = 'success') {
    this.scenario = scenario
  }

  setScenario(scenario: MockOAuthScenario): void {
    this.scenario = scenario
    this.refreshCount = 0
  }

  async login(): Promise<OAuthCredential> {
    switch (this.scenario) {
      case 'user_cancelled':
        throw new Error('User cancelled the login')

      case 'state_mismatch':
        throw new Error('State mismatch')

      case 'callback_timeout':
        throw new Error('Callback timeout')

      case 'token_exchange_400':
        throw new Error('Token exchange failed: 400')

      default:
        return this.makeCredential(Date.now() + 3600000)
    }
  }

  async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    this.refreshCount++

    switch (this.scenario) {
      case 'refresh_invalid_grant':
        throw new Error('invalid_grant')

      case '401_refresh_retry_failed':
        throw new Error('invalid_grant')

      default:
        return this.makeCredential(Date.now() + 3600000)
    }
  }

  async logout(_credential: OAuthCredential): Promise<void> {
    // no-op
  }

  private makeCredential(expiresAt: number): OAuthCredential {
    // 构造一个 fake JWT，payload 包含必需的 claim
    const payload = {
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_mock',
      },
      exp: Math.floor(expiresAt / 1000),
    }

    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const accessToken = `${header}.${body}.mock_signature`

    // 构造 fake ID token
    const idTokenPayload = {
      email: 'mock@example.com',
      chatgpt_plan_type: 'free',
      chatgpt_user_id: 'user_mock',
    }
    const idTokenBody = Buffer.from(JSON.stringify(idTokenPayload)).toString('base64url')
    const idToken = `${header}.${idTokenBody}.mock_signature`

    return {
      accessToken,
      refreshToken: `mock-refresh-${this.refreshCount}`,
      expiresAt,
      accountId: 'acct_mock',
      email: 'mock@example.com',
      planType: 'free',
      userId: 'user_mock',
    }
  }
}