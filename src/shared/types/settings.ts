export type ProxyProtocol = 'http' | 'https' | 'socks5'

export interface ProxyConfig {
  enabled: boolean
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
}

export type WebSearchEngineType = 'bing' | 'baidu'