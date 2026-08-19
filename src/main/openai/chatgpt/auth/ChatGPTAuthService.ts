import type { OAuthClient } from './OAuthClient'
import type { OAuthCredential } from './OAuthCredentialStore'
import { OAuthCredentialManager, NotAuthenticatedError } from './OAuthCredentialManager'
import type { PublicAccountInfo, AuthStatus } from '../../../../shared/types/account'

/**
 * ChatGPT Direct OAuth AuthService
 * 与旧 AuthService 接口兼容，但使用 OAuthCredentialManager + OAuthClient
 */
export class ChatGPTAuthService {
  private credentialManager: OAuthCredentialManager
  private oauthClient: OAuthClient
  private status: AuthStatus = 'unknown'
  private statusChangeHandlers: Array<(status: AuthStatus) => void> = []

  constructor(credentialManager: OAuthCredentialManager, oauthClient: OAuthClient) {
    this.credentialManager = credentialManager
    this.oauthClient = oauthClient
  }

  get currentStatus(): AuthStatus {
    return this.status
  }

  get currentAccount(): PublicAccountInfo {
    // 同步快照，仅用于初始化
    return { loggedIn: this.status === 'logged-in', email: null, planType: null, accountId: null }
  }

  onStatusChange(handler: (status: AuthStatus) => void): void {
    this.statusChangeHandlers.push(handler)
  }

  private emitStatusChange(): void {
    for (const handler of this.statusChangeHandlers) {
      handler(this.status)
    }
  }

  private setStatusAndEmit(newStatus: AuthStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus
      this.emitStatusChange()
    }
  }

  async checkAuth(): Promise<PublicAccountInfo> {
    try {
      const loggedIn = await this.credentialManager.isLoggedIn()
      if (loggedIn) {
        this.setStatusAndEmit('logged-in')
        const info = await this.credentialManager.getPublicAccountInfo()
        return info
      } else {
        this.setStatusAndEmit('logged-out')
        return { loggedIn: false, email: null, planType: null, accountId: null }
      }
    } catch {
      this.setStatusAndEmit('logged-out')
      return { loggedIn: false, email: null, planType: null, accountId: null }
    }
  }

  async loginBrowser(): Promise<string> {
    this.setStatusAndEmit('logging-in')

    try {
      await this.credentialManager.login()
      this.setStatusAndEmit('logged-in')
      return '' // URL 由 OpenAIOAuthClient 内部处理
    } catch (err) {
      this.setStatusAndEmit('logged-out')
      throw err
    }
  }

  async loginDeviceCode(): Promise<{ verificationUrl: string; userCode: string }> {
    // Direct Provider 不支持 device code flow
    throw new Error('Device code flow is not supported in direct provider')
  }

  async cancelLogin(): Promise<void> {
    this.setStatusAndEmit('logged-out')
  }

  async logout(): Promise<void> {
    await this.credentialManager.logout()
    this.setStatusAndEmit('logged-out')
  }
}