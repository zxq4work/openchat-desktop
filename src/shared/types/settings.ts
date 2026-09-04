export type ProxyProtocol = 'http' | 'https' | 'socks5'

export type ProxyMode = 'direct' | 'system' | 'http' | 'socks5'

export interface ProxyConfig {
  enabled: boolean
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
  mode?: ProxyMode
}

export type WebSearchEngineType = 'bing' | 'baidu' | 'google'

export interface WebSearchConfig {
  maxResults: number
  maxToolRounds: number
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  maxResults: 10,
  maxToolRounds: 3,
}