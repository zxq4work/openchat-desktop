// Web Search 相关类型定义
// 与 ChatGPT Codex standalone search endpoint 及 web.run tool schema 保持一致

export interface SearchQuery {
  q: string
  recency?: number
  domains?: string[]
}

export interface OpenOperation {
  ref_id: string
  lineno?: number
}

export interface ClickOperation {
  ref_id: string
  id: number
}

export interface FindOperation {
  ref_id: string
  pattern: string
}

export interface ScreenshotOperation {
  ref_id: string
  pageno: number
}

export interface FinanceOperation {
  // 预留扩展
  [key: string]: unknown
}

export interface WeatherOperation {
  // 预留扩展
  [key: string]: unknown
}

export interface SportsOperation {
  // 预留扩展
  [key: string]: unknown
}

export interface TimeOperation {
  // 预留扩展
  [key: string]: unknown
}

export type SearchResponseLength = 'short' | 'medium' | 'long'

export interface SearchCommands {
  search_query?: SearchQuery[]
  image_query?: SearchQuery[]

  open?: OpenOperation[]
  click?: ClickOperation[]
  find?: FindOperation[]
  screenshot?: ScreenshotOperation[]

  finance?: FinanceOperation[]
  weather?: WeatherOperation[]
  sports?: SportsOperation[]
  time?: TimeOperation[]

  response_length?: SearchResponseLength
}

export type SearchContextSize = 'low' | 'medium' | 'high'

export type ExternalWebAccess = boolean | 'cached' | 'indexed' | 'live'

export interface SearchSettings {
  user_location?: {
    type: 'approximate'
    country?: string
    region?: string
    city?: string
    timezone?: string
  }

  search_context_size?: SearchContextSize

  filters?: {
    allowed_domains?: string[]
    blocked_domains?: string[]
  }

  image_settings?: {
    max_results?: number
    caption?: boolean
  }

  allowed_callers?: Array<'direct' | 'shell' | 'code_interpreter'>

  external_web_access?: ExternalWebAccess
}

export type SearchInput = string | ProviderResponseItem[]

export interface ProviderResponseItem {
  // 与 Responses API 的 output item 保持一致
  type: string
  [key: string]: unknown
}

export interface SearchRequest {
  id: string
  model: string

  reasoning?: unknown

  input?: SearchInput

  commands?: SearchCommands

  settings?: SearchSettings

  max_output_tokens?: number
}

export interface SearchResponse {
  encrypted_output?: string
  output: string
  results?: unknown[]
}

// 默认 settings（不发送用户精确位置）
export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  search_context_size: 'medium',
  external_web_access: 'live',
}
