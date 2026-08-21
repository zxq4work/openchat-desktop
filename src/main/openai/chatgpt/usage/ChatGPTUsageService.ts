import { ChatGPTUsageClient } from './ChatGPTUsageClient'
import type { OAuthCredentialManager } from '../auth/OAuthCredentialManager'
import type {
  ChatGPTUsageResponse,
  CodexUsageAvailability,
  CodexUsageView,
} from '../../../../shared/types/usage'

const CACHE_TTL_MS = 60_000
const RESET_GRACE_MS = 15_000

export type UsageChangeHandler = (state: CodexUsageView) => void

/**
 * 管理 Codex Usage 状态：
 * - 缓存 usage 响应（60s TTL）
 * - 判断 Codex 是否可用
 * - 计算 resetAt
 * - 到达 reset 时间后自动刷新
 */
export class ChatGPTUsageService {
  private client: ChatGPTUsageClient
  private state: CodexUsageAvailability = { state: 'unknown' }
  private resetTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: UsageChangeHandler[] = []

  constructor(credentialManager: OAuthCredentialManager) {
    this.client = new ChatGPTUsageClient(credentialManager)
  }

  onChange(handler: UsageChangeHandler): void {
    this.listeners.push(handler)
  }

  getState(): CodexUsageAvailability {
    return this.state
  }

  getView(): CodexUsageView {
    return this.toView(this.state)
  }

  async refresh(): Promise<void> {
    this.clearResetTimer()

    try {
      const usage = await this.client.getUsage()
      const now = Date.now()

      const rateLimit = usage.rate_limit
      const isExhausted =
        rateLimit?.allowed === false || rateLimit?.limit_reached === true

      if (isExhausted) {
        const resetAt = this.computeResetAt(usage)
        this.state = { state: 'exhausted', usage, resetAt, fetchedAt: now }
        this.scheduleResetRefresh(resetAt)
      } else {
        this.state = { state: 'available', usage, fetchedAt: now }
      }

      this.logUsage(usage)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Codex Usage] fetch failed:', message)
      this.state = { state: 'unavailable', error: message, fetchedAt: Date.now() }
    } finally {
      this.emitChange()
    }
  }

  /**
   * 尝试获取最新 usage（如果缓存过期或未知状态）。
   * 返回当前 state，不阻塞调用方。
   */
  async ensureFresh(): Promise<CodexUsageAvailability> {
    const state = this.state
    if (state.state === 'unknown') {
      await this.refresh()
      return this.state
    }

    const now = Date.now()
    if (now - state.fetchedAt >= CACHE_TTL_MS) {
      await this.refresh()
    }

    return this.state
  }

  /**
   * 由 /codex/responses 返回 429 usage_limit_reached 时调用，
   * 强制更新为 exhausted 状态。
   */
  markExhaustedFrom429(resetAt?: number): void {
    this.clearResetTimer()

    const usage = this.state.state === 'available' || this.state.state === 'exhausted'
      ? this.state.usage
      : undefined

    this.state = {
      state: 'exhausted',
      usage: usage ?? {},
      resetAt,
      fetchedAt: Date.now(),
    }

    if (resetAt) {
      this.scheduleResetRefresh(resetAt)
    }

    this.emitChange()
  }

  private computeResetAt(usage: ChatGPTUsageResponse): number | undefined {
    const fromUpsell = usage.rate_limit_upsell?.reset_at
    if (typeof fromUpsell === 'number') return fromUpsell

    const primary = usage.rate_limit?.primary_window?.reset_at
    const secondary = usage.rate_limit?.secondary_window?.reset_at

    if (typeof primary === 'number' && typeof secondary === 'number') {
      return Math.max(primary, secondary)
    }
    return primary ?? secondary ?? undefined
  }

  private scheduleResetRefresh(resetAt: number | undefined): void {
    if (typeof resetAt !== 'number') return

    const resetMs = resetAt * 1000
    const delay = resetMs - Date.now() + RESET_GRACE_MS

    if (delay <= 0) {
      // 已经过了 reset 时间，立即刷新
      void this.refresh()
      return
    }

    // 安全上限：最多等 24 小时
    const cappedDelay = Math.min(delay, 24 * 60 * 60 * 1000)

    this.resetTimer = setTimeout(() => {
      void this.refresh()
    }, cappedDelay)
  }

  private clearResetTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
      this.resetTimer = null
    }
  }

  private toView(state: CodexUsageAvailability): CodexUsageView {
    if (state.state === 'unknown') return { state: 'unknown' }
    if (state.state === 'unavailable') return { state: 'unavailable' }

    const usage = state.usage
    const primaryWindow = usage.rate_limit?.primary_window

    // used_percent 直接使用服务器返回，服务器缺失时 exhausted 兜底 100
    const usedPercent =
      primaryWindow?.used_percent ?? (state.state === 'exhausted' ? 100 : undefined)

    return {
      state: state.state,
      planType: usage.plan_type,
      usedPercent,
      windowSeconds: primaryWindow?.limit_window_seconds,
      resetAt: state.state === 'exhausted' ? state.resetAt : undefined,
      hasCredits: usage.credits?.has_credits,
    }
  }

  private emitChange(): void {
    const view = this.toView(this.state)
    for (const handler of this.listeners) {
      try {
        handler(view)
      } catch {
        // 忽略 listener 异常
      }
    }
  }

  private logUsage(usage: ChatGPTUsageResponse): void {
    const rl = usage.rate_limit
    const primary = rl?.primary_window
    console.log(
      '[Codex Usage]',
      `plan=${usage.plan_type ?? 'unknown'}`,
      `allowed=${rl?.allowed}`,
      `limitReached=${rl?.limit_reached}`,
      `primaryUsed=${primary?.used_percent ?? 'none'}`,
      `primaryResetAt=${primary?.reset_at ?? 'none'}`
    )
  }
}