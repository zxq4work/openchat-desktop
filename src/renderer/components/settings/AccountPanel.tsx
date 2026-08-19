import React from 'react'
import { useAuthStore } from '../../stores/authStore'

export function AccountPanel() {
  const email = useAuthStore((s) => s.email)
  const planType = useAuthStore((s) => s.planType)
  const accountId = useAuthStore((s) => s.accountId)
  const status = useAuthStore((s) => s.status)
  const setStatus = useAuthStore((s) => s.setStatus)
  const setAccount = useAuthStore((s) => s.setAccount)

  const handleLogin = async () => {
    setStatus('logging-in')
    try {
      await window.openchat.auth.loginBrowser()
      // 登录后刷新状态
      const account = await window.openchat.auth.getStatus()
      if (account.loggedIn) {
        setStatus('logged-in')
        setAccount(account.email, account.planType, account.accountId)
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
        // 设备码登录后也需要刷新状态
        const account = await window.openchat.auth.getStatus()
        if (account.loggedIn) {
          setStatus('logged-in')
          setAccount(account.email, account.planType, account.accountId)
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
    setAccount(null, null, null)
  }

  if (status === 'logged-in') {
    return (
      <div className="account-panel">
        <div className="account-info">
          {accountId && <div>账号：{accountId}</div>}
          {email && <div>邮箱：{email}</div>}
          <div>套餐：{planType ?? '未知'}</div>
          <div>状态：已登录</div>
        </div>
        <button className="btn-logout" onClick={handleLogout}>退出登录</button>
      </div>
    )
  }

  return (
    <div className="account-panel">
      <p>尚未登录</p>
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