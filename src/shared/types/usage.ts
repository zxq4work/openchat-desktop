// ---- Server response types ----

export interface UsageWindow {
  used_percent: number
  limit_window_seconds: number
  reset_after_seconds: number
  reset_at: number
}

export interface UsageRateLimit {
  allowed: boolean
  limit_reached: boolean
  primary_window: UsageWindow | null
  secondary_window: UsageWindow | null
}

export interface UsageCredits {
  has_credits: boolean
  unlimited: boolean
  overage_limit_reached: boolean
  balance: number | string | null
  approx_local_messages: number | null
  approx_cloud_messages: number | null
}

export interface ChatGPTUsageResponse {
  user_id?: string
  account_id?: string
  email?: string
  plan_type?: string

  rate_limit?: UsageRateLimit | null
  code_review_rate_limit?: unknown
  additional_rate_limits?: unknown[] | null
  credits?: UsageCredits | null
  spend_control?: { reached?: boolean; individual_limit?: unknown } | null
  rate_limit_reached_type?: { type?: string; details?: string } | null
  rate_limit_upsell?: {
    banner_type?: string
    title?: string
    description?: string
    reset_at?: number
    [key: string]: unknown
  } | null
  promo?: unknown
  rate_limit_reset_credits?: {
    available_count?: number
    applicable_available_count?: number
  } | null

  [key: string]: unknown
}

// ---- Internal state ----

export type CodexUsageAvailability =
  | { state: 'unknown' }
  | { state: 'available'; usage: ChatGPTUsageResponse; fetchedAt: number }
  | { state: 'exhausted'; usage: ChatGPTUsageResponse; resetAt?: number; fetchedAt: number }
  | { state: 'unavailable'; error: string; fetchedAt: number }

// ---- Renderer DTO (never exposes raw response) ----

export interface CodexUsageView {
  state: 'unknown' | 'available' | 'exhausted' | 'unavailable'
  planType?: string
  usedPercent?: number
  windowSeconds?: number
  resetAt?: number
  hasCredits?: boolean
}

// ---- Error ----

export class CodexUsageExhaustedError extends Error {
  code: 'CODEX_USAGE_EXHAUSTED' = 'CODEX_USAGE_EXHAUSTED'
  resetAt?: number
  planType?: string

  constructor(resetAt?: number, planType?: string) {
    super('Codex usage exhausted')
    this.name = 'CodexUsageExhaustedError'
    this.resetAt = resetAt
    this.planType = planType
  }
}