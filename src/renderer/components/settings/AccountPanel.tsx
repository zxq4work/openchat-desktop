import React, { useState } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useCodexUsageStore } from '../../stores/codexUsageStore'
import type { CodexUsageView } from '../../../shared/types/usage'
import { ConfirmDialog } from '../ConfirmDialog'

function formatWindowSeconds(seconds: number): string {
  const days = Math.round(seconds / 86400)
  if (days >= 1) return `${days} 天`
  const hours = Math.round(seconds / 3600)
  return `${hours} 小时`
}

function formatRelativeTime(resetAt: number): string {
  const now = Date.now()
  const remainMs = resetAt * 1000 - now
  const remainMinutes = Math.max(0, Math.ceil(remainMs / 60000))
  const remainHours = Math.floor(remainMinutes / 60)

  if (remainHours >= 24) {
    const days = Math.floor(remainHours / 24)
    const leftoverHours = remainHours % 24
    return leftoverHours > 0 ? `${days}天${leftoverHours}时` : `${days}天`
  }
  if (remainHours > 0) {
    const remainMins = remainMinutes % 60
    return remainMins > 0 ? `${remainHours}时${remainMins}分` : `${remainHours}时`
  }
  return `${remainMinutes}分`
}

function formatAbsoluteTime(resetAt: number): string {
  const d = new Date(resetAt * 1000)
  const y = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${month}-${day} ${hours}:${minutes}`
}

function renderUsageSection(
  usage: CodexUsageView,
  refreshing: boolean,
  onRefresh: () => void
): React.ReactNode {
  if (usage.state === 'unknown') {
    return (
      <div className="usage-summary">
        <span className="usage-label">Codex</span>
        <span className="usage-state-unknown">查询中...</span>
      </div>
    )
  }

  if (usage.state === 'unavailable') {
    return (
      <div className="usage-summary">
        <span className="usage-label">Codex</span>
        <span className="usage-state-unavailable">状态未知</span>
      </div>
    )
  }

  const planLabel = usage.planType ? `${usage.planType.charAt(0).toUpperCase() + usage.planType.slice(1)} · Codex` : 'Codex'

  if (usage.state === 'exhausted') {
    return (
      <div className="usage-detail">
        <div className="usage-detail-header">
          <span className="usage-label">{planLabel}</span>
          <span className="usage-state-badge usage-state-exhausted">额度已用尽</span>
        </div>
        <div className="usage-detail-row">
          <span className="usage-detail-key">已使用</span>
          <span className="usage-detail-value">100%</span>
        </div>
        {usage.windowSeconds != null && (
          <div className="usage-detail-row">
            <span className="usage-detail-key">窗口</span>
            <span className="usage-detail-value">{formatWindowSeconds(usage.windowSeconds)}</span>
          </div>
        )}
        {usage.resetAt != null && (
          <div className="usage-detail-row">
            <span className="usage-detail-key">重置剩余时间</span>
            <span className="usage-detail-value usage-detail-value-tooltip">
              {formatRelativeTime(usage.resetAt)}
              <span className="usage-detail-tooltip">{formatAbsoluteTime(usage.resetAt)}</span>
            </span>
          </div>
        )}
        <button
          className="usage-refresh-btn"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? '刷新中...' : '刷新'}
        </button>
      </div>
    )
  }

  // available
  const primaryUsedPercent = usage.usedPercent ?? 0
  const secondaryUsedPercent = usage.secondaryUsedPercent ?? 0
  const hasSecondary = usage.secondaryWindowSeconds != null

  return (
    <div className="usage-detail">
      <div className="usage-detail-header">
        <span className="usage-label">{planLabel}</span>
        <span className="usage-state-badge usage-state-available">可用</span>
      </div>

      {/* Primary window */}
      {usage.windowSeconds != null && (
        <>
          <div className="usage-detail-row">
            <span className="usage-detail-key">{formatWindowSeconds(usage.windowSeconds)} 用量</span>
            <span className="usage-detail-value">{primaryUsedPercent}%</span>
          </div>
          <div className="usage-progress-bar">
            <div
              className="usage-progress-fill"
              style={{ width: `${Math.min(primaryUsedPercent, 100)}%` }}
            />
          </div>
          {usage.resetAt != null && (
            <div className="usage-detail-row">
              <span className="usage-detail-key">重置剩余时间</span>
              <span className="usage-detail-value usage-detail-value-tooltip">
                {formatRelativeTime(usage.resetAt)}
                <span className="usage-detail-tooltip">{formatAbsoluteTime(usage.resetAt)}</span>
              </span>
            </div>
          )}
        </>
      )}

      {/* Secondary window */}
      {hasSecondary && (
        <>
          <div className="usage-detail-row" style={{ marginTop: 8 }}>
            <span className="usage-detail-key">{formatWindowSeconds(usage.secondaryWindowSeconds!)} 用量</span>
            <span className="usage-detail-value">{secondaryUsedPercent}%</span>
          </div>
          <div className="usage-progress-bar">
            <div
              className="usage-progress-fill"
              style={{ width: `${Math.min(secondaryUsedPercent, 100)}%` }}
            />
          </div>
          {usage.secondaryResetAt != null && (
            <div className="usage-detail-row">
              <span className="usage-detail-key">重置剩余时间</span>
              <span className="usage-detail-value usage-detail-value-tooltip">
                {formatRelativeTime(usage.secondaryResetAt)}
                <span className="usage-detail-tooltip">{formatAbsoluteTime(usage.secondaryResetAt)}</span>
              </span>
            </div>
          )}
        </>
      )}

      <button
        className="usage-refresh-btn"
        onClick={onRefresh}
        disabled={refreshing}
      >
        {refreshing ? '刷新中...' : '刷新'}
      </button>
    </div>
  )
}

export function AccountPanel() {
  const email = useAuthStore((s) => s.email)
  const planType = useAuthStore((s) => s.planType)
  const accountId = useAuthStore((s) => s.accountId)
  const status = useAuthStore((s) => s.status)
  const setStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)
  const usage = useCodexUsageStore((s) => s.usage)

  const [accountIdCopied, setAccountIdCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)

  const handleRefreshUsage = async () => {
    setRefreshing(true)
    try {
      await window.openchat.codexUsage.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const handleLogin = async () => {
    setStatus('logging-in')
    try {
      await window.openchat.auth.loginBrowser()
      const account = await window.openchat.auth.getStatus()
      if (account.loggedIn) {
        setStatus('logged-in')
        setAccount(account.email, account.planType, account.userId, account.accountId)
      } else {
        setStatus('logged-out')
      }
    } catch (err) {
      setStatus('logged-out')
      const message = err instanceof Error ? err.message : String(err)
      alert(`登录失败：${message}`)
    }
  }

  const handleDeviceCode = async () => {
    setStatus('logging-in')
    try {
      const result = await window.openchat.auth.loginDeviceCode()
      if (result.userCode) {
        alert(`设备验证码：${result.userCode}\n请在浏览器打开：${result.verificationUrl}`)
        const account = await window.openchat.auth.getStatus()
        if (account.loggedIn) {
          setStatus('logged-in')
          setAccount(account.email, account.planType, account.userId, account.accountId)
        } else {
          setStatus('logged-out')
        }
      }
    } catch (err) {
      setStatus('logged-out')
      const message = err instanceof Error ? err.message : String(err)
      alert(`设备验证码登录失败：${message}`)
    }
  }

  const handleLogout = async () => {
    await window.openchat.auth.logout()
    setStatus('logged-out')
    setAccount(null, null, null, null)
  }

  const handleCopyAccountId = async () => {
    if (!accountId) return
    try {
      await navigator.clipboard.writeText(accountId)
      setAccountIdCopied(true)
      setTimeout(() => setAccountIdCopied(false), 2000)
    } catch {
      // fallback
      const textarea = document.createElement('textarea')
      textarea.value = accountId
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setAccountIdCopied(true)
      setTimeout(() => setAccountIdCopied(false), 2000)
    }
  }

  if (status === 'logged-in') {
    return (
      <div className="account-panel">
        <div className="account-info">
          <div className="account-email">{email || '未知用户'}</div>
          <div className="account-meta">
            {planType && <span className="account-plan">{planType.charAt(0).toUpperCase() + planType.slice(1)}</span>}
            {planType && <span className="account-separator">·</span>}
            <span className="account-status-logged-in">已登录</span>
          </div>
          <button className="btn-logout-outline" onClick={() => setLogoutConfirmOpen(true)}>退出登录</button>
          {accountId && (
            <div className="account-id-row">
              <span className="account-id-label">Account ID</span>
              <code className="account-id-value">{accountId}</code>
              <button
                className="account-id-copy-btn"
                onClick={handleCopyAccountId}
                title="复制 Account ID"
              >
                {accountIdCopied ? '已复制' : '复制'}
              </button>
            </div>
          )}
          <div className="account-usage">
            {renderUsageSection(usage, refreshing, handleRefreshUsage)}
          </div>
        </div>

        <ConfirmDialog
          open={logoutConfirmOpen}
          title="退出登录"
          message="确定要退出当前账号吗？"
          confirmText="确认退出"
          onConfirm={async () => {
            await handleLogout()
            setLogoutConfirmOpen(false)
          }}
          onCancel={() => setLogoutConfirmOpen(false)}
        />
      </div>
    )
  }

  return (
    <div className="account-panel">
      <p className="account-not-logged-in">尚未登录</p>
      <div className="login-actions">
        <button className="btn-login" onClick={handleLogin} disabled={status === 'logging-in'}>
          使用浏览器登录
        </button>
        <button className="btn-login-device" onClick={handleDeviceCode} disabled={status === 'logging-in'}>
          使用设备验证码登录
        </button>
      </div>
    </div>
  )
}