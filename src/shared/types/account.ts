// Renderer 只允许获得这些公开账号信息，绝不能拿 token
export interface PublicAccountInfo {
  loggedIn: boolean
  email: string | null
  planType: string | null
  userId: string | null
  accountId: string | null
}

export type AuthStatus = 'unknown' | 'logged-out' | 'logging-in' | 'logged-in'