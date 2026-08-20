/**
 * OAuth 凭证持久化接口
 * 实际安全存储实现（keychain 等）后续独立处理
 */

export interface OAuthCredential {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
  accountId: string // from JWT claim https://api.openai.com/auth → chatgpt_account_id
  email: string // from ID token email / profile.email
  planType: string // from chatgpt_plan_type
  userId: string // from chatgpt_user_id
}

export interface OAuthCredentialStore {
  load(): Promise<OAuthCredential | null>
  save(credential: OAuthCredential): Promise<void>
  clear(): Promise<void>
}

/**
 * 基于 SQLite settings 表的文件存储实现
 * 使用 base64 编码，非加密存储（后续替换为 keychain）
 */
export class FileOAuthCredentialStore implements OAuthCredentialStore {
  private settingsRepo: SettingsRepository

  constructor(settingsRepo: SettingsRepository) {
    this.settingsRepo = settingsRepo
  }

  async load(): Promise<OAuthCredential | null> {
    const raw = this.settingsRepo.get('oauth_credential')
    if (!raw) return null
    try {
      const json = Buffer.from(raw, 'base64').toString('utf8')
      return JSON.parse(json) as OAuthCredential
    } catch {
      return null
    }
  }

  async save(credential: OAuthCredential): Promise<void> {
    const json = JSON.stringify(credential)
    const encoded = Buffer.from(json, 'utf8').toString('base64')
    this.settingsRepo.set('oauth_credential', encoded)
  }

  async clear(): Promise<void> {
    this.settingsRepo.remove('oauth_credential')
  }
}

/**
 * SettingsRepository 的最小接口
 * 实际实现来自 src/main/storage/SettingsRepository.ts（同步方法）
 */
export interface SettingsRepository {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}