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

  async initialize(): Promise<void> {
    await this.credentialManager.initialize()
  }
}