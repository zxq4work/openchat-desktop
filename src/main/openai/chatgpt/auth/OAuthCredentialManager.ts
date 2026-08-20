import type { OAuthClient } from './OAuthClient'
import type { OAuthCredential, OAuthCredentialStore } from './OAuthCredentialStore'
import type { PublicAccountInfo } from '../../../../shared/types/account'

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000 // 提前 5 分钟刷新

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'NotAuthenticatedError'
  }
}

/**
 * OAuth 凭证管理器
 * 只存在于 Electron Main 进程，token 绝不进入 Renderer
 */
export class OAuthCredentialManager {
  private store: OAuthCredentialStore
  private oauthClient: OAuthClient
  private credential: OAuthCredential | null = null

  constructor(store: OAuthCredentialStore, oauthClient: OAuthClient) {
    this.store = store
    this.oauthClient = oauthClient
  }

  async initialize(): Promise<void> {
    this.credential = await this.store.load()

    // 旧版本凭证可能缺少 email/planType/userId，强制刷新以获取 ID Token
    if (this.credential && (!this.credential.email || !this.credential.planType || !this.credential.userId)) {
      try {
        await this.refreshToken()
      } catch {
        // 刷新失败不影响使用，保留现有凭证
      }
    }

    if (this.credential) {
      console.log('[Account] logged in:', this.credential.email, '| plan:', this.credential.planType || 'unknown', '| userId:', this.credential.userId || 'unknown')
    }
  }

  async isLoggedIn(): Promise<boolean> {
    if (!this.credential) return false
    // 已过期且无法刷新则视为未登录
    if (this.isExpired(this.credential)) {
      try {
        await this.refreshToken()
      } catch {
        return false
      }
    }
    return true
  }

  async getAccessToken(): Promise<string> {
    if (!this.credential) {
      throw new NotAuthenticatedError()
    }

    // 提前 5 分钟刷新
    if (this.isExpired(this.credential)) {
      await this.refreshToken()
    }

    return this.credential.accessToken
  }

  async getAccountId(): Promise<string | null> {
    if (!this.credential) return null
    return this.credential.accountId
  }

  async getPublicAccountInfo(): Promise<PublicAccountInfo> {
    if (!this.credential) {
      return { loggedIn: false, email: null, planType: null, userId: null, accountId: null }
    }
    return {
      loggedIn: true,
      email: this.credential.email || null,
      planType: this.credential.planType || null,
      userId: this.credential.userId || null,
      accountId: this.credential.accountId || null,
    }
  }

  async login(): Promise<void> {
    const credential = await this.oauthClient.login()
    this.credential = credential
    await this.store.save(credential)
  }

  async logout(): Promise<void> {
    if (this.credential) {
      try {
        await this.oauthClient.logout(this.credential)
      } catch {
        // 忽略
      }
    }
    this.credential = null
    await this.store.clear()
  }

  /**
   * 401 时：刷新一次 → 重试一次，禁止无限重试
   */
  async handleUnauthorized(): Promise<void> {
    if (!this.credential) {
      throw new NotAuthenticatedError()
    }
    await this.refreshToken()
  }

  private async refreshToken(): Promise<void> {
    if (!this.credential) {
      throw new NotAuthenticatedError()
    }

    const newCredential = await this.oauthClient.refresh(this.credential)
    this.credential = newCredential
    await this.store.save(newCredential)
  }

  private isExpired(credential: OAuthCredential): boolean {
    return Date.now() >= credential.expiresAt - REFRESH_THRESHOLD_MS
  }
}