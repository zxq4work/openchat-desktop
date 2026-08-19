import { OpenAIAppServerClient } from './OpenAIAppServerClient'
import type { PublicAccountInfo, AuthStatus } from '../../shared/types/account'
import type { AccountLoginCompletedNotification } from '../../../vendor/openai/codex-0.148.0/schema-ts/v2/AccountLoginCompletedNotification'
import type { AccountUpdatedNotification } from '../../../vendor/openai/codex-0.148.0/schema-ts/v2/AccountUpdatedNotification'

export class AuthService {
  private client: OpenAIAppServerClient
  private accountInfo: PublicAccountInfo = { loggedIn: false, email: null, planType: null, accountId: null }
  private status: AuthStatus = 'unknown'
  private pendingLoginId: string | null = null
  private statusChangeHandlers: Array<(status: AuthStatus) => void> = []

  constructor(client: OpenAIAppServerClient) {
    this.client = client
    this.setupNotifications()
  }

  get currentStatus(): AuthStatus {
    return this.status
  }

  get currentAccount(): PublicAccountInfo {
    return { ...this.accountInfo }
  }

  onStatusChange(handler: (status: AuthStatus) => void): void {
    this.statusChangeHandlers.push(handler)
  }

  private emitStatusChange(): void {
    for (const handler of this.statusChangeHandlers) {
      handler(this.status)
    }
  }

  private setupNotifications(): void {
    this.client.onNotification('account/login/completed', (params: unknown) => {
      const notification = params as AccountLoginCompletedNotification
      this.handleLoginCompleted(notification)
    })

    this.client.onNotification('account/updated', (params: unknown) => {
      const notification = params as AccountUpdatedNotification
      this.handleAccountUpdated(notification)
    })
  }

  async checkAuth(): Promise<PublicAccountInfo> {
    try {
      const result = await this.client.readAccount()
      if (result.account) {
        const account = result.account
        this.accountInfo = {
          loggedIn: true,
          email: account.type === 'chatgpt' ? account.email : null,
          planType: account.type === 'chatgpt' ? account.planType : null,
          accountId: null,
        }
        this.status = 'logged-in'
      } else {
        this.accountInfo = { loggedIn: false, email: null, planType: null, accountId: null }
        this.status = 'logged-out'
      }
    } catch {
      this.accountInfo = { loggedIn: false, email: null, planType: null, accountId: null }
      this.status = 'logged-out'
    }
    this.emitStatusChange()
    return this.currentAccount
  }

  async loginBrowser(): Promise<string> {
    this.status = 'logging-in'
    this.emitStatusChange()

    const result = await this.client.loginChatGPT()
    if (result.type === 'chatgpt') {
      this.pendingLoginId = result.loginId
      return result.authUrl
    }
    return ''
  }

  async loginDeviceCode(): Promise<{ verificationUrl: string; userCode: string }> {
    this.status = 'logging-in'
    this.emitStatusChange()

    const result = await this.client.loginDeviceCode()
    if (result.type === 'chatgptDeviceCode') {
      this.pendingLoginId = result.loginId
      return {
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      }
    }
    return { verificationUrl: '', userCode: '' }
  }

  async cancelLogin(): Promise<void> {
    if (this.pendingLoginId) {
      await this.client.cancelLogin(this.pendingLoginId)
      this.pendingLoginId = null
      this.status = 'logged-out'
      this.emitStatusChange()
    }
  }

  async logout(): Promise<void> {
    await this.client.logout()
    this.accountInfo = { loggedIn: false, email: null, planType: null, accountId: null }
    this.status = 'logged-out'
    this.emitStatusChange()
  }

  private async handleLoginCompleted(notification: AccountLoginCompletedNotification): Promise<void> {
    this.pendingLoginId = null
    if (notification.success) {
      // 登录成功后重新确认账号信息
      await this.checkAuth()
    } else {
      this.status = 'logged-out'
      this.emitStatusChange()
    }
  }

  private handleAccountUpdated(notification: AccountUpdatedNotification): void {
    if (notification.authMode === null) {
      this.accountInfo = { loggedIn: false, email: null, planType: null, accountId: null }
      this.status = 'logged-out'
      this.emitStatusChange()
    }
  }
}