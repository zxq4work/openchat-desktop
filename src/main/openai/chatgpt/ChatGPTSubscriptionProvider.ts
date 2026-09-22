import type { OAuthClient } from './auth/OAuthClient'
import type { ChatGPTCodexClient } from './transport/ChatGPTCodexClient'
import { OAuthCredentialManager } from './auth/OAuthCredentialManager'
import { ChatGPTAuthService } from './auth/ChatGPTAuthService'
import { ChatGPTModelService } from './models/ChatGPTModelService'

/**
 * ChatGPT Subscription Provider
 * 组合根：将 OAuth、Transport、Model、Auth 服务装配在一起
 */
export class ChatGPTSubscriptionProvider {
  readonly credentialManager: OAuthCredentialManager
  readonly authService: ChatGPTAuthService
  readonly modelService: ChatGPTModelService
  readonly codexClient: ChatGPTCodexClient

  constructor(
    credentialManager: OAuthCredentialManager,
    oauthClient: OAuthClient,
    codexClient: ChatGPTCodexClient
  ) {
    this.credentialManager = credentialManager
    this.authService = new ChatGPTAuthService(credentialManager, oauthClient)
    this.modelService = new ChatGPTModelService(codexClient)
    this.codexClient = codexClient
  }

  // deferTokenRefresh：为 true 时只加载本地凭证，不在此处强制网络刷新 token。
  // 启动阻塞路径只做本地文件读取；缺字段的旧凭证由后台 ensureProfile() 补齐，
  // 避免首次安装 / 冷启动时 token 刷新（网络）长时间阻塞 Splash。
  async initialize(opts: { deferTokenRefresh?: boolean } = {}): Promise<void> {
    await this.credentialManager.initialize({ deferTokenRefresh: opts.deferTokenRefresh })
  }
}