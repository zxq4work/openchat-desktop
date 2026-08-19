import type { OAuthCredential } from './OAuthCredentialStore'

/**
 * OAuthClient 接口
 * 业务层只依赖此接口，支持真实和 Mock 实现
 */
export interface OAuthClient {
  login(): Promise<OAuthCredential>
  refresh(credential: OAuthCredential): Promise<OAuthCredential>
  logout(credential: OAuthCredential): Promise<void>
}