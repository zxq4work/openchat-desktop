import React, { useState } from 'react'
import { useAuthStore } from '../../stores/authStore'

export function AccountPanel() {
  const email = useAuthStore((s) => s.email)
  const planType = useAuthStore((s) => s.planType)
  const accountId = useAuthStore((s) => s.accountId)
  const status = useAuthStore((s) => s.status)
  const setStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)

  const [accountIdCopied, setAccountIdCopied] = useState(false)

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
            {planType && <span className="account-plan">{planType}</span>}
            {planType && <span className="account-separator">·</span>}
            <span className="account-status-logged-in">已登录</span>
          </div>
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
        </div>
        <button className="btn-logout-outline" onClick={handleLogout}>退出登录</button>
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