import React from 'react'
import { useUiStore } from '../stores/uiStore'
import { rlog } from '../app/boot-log'

// 初始化失败 / 超时的降级界面。由 uiStore.initError 驱动。
// 展示错误详情 + 「重试初始化」，绝不无限停在 Splash。
// 重试成功后由 Main 推送 finish（或 Renderer 下一次 getBootState 拉到 canFinish）收尾。
export function InitErrorScreen() {
  const initError = useUiStore((s) => s.initError)
  const initRetrying = useUiStore((s) => s.initRetrying)
  const setInitError = useUiStore((s) => s.setInitError)
  const setInitRetrying = useUiStore((s) => s.setInitRetrying)

  if (!initError) return null

  const handleRetry = async () => {
    if (initRetrying) return
    setInitRetrying(true)
    rlog('init-error: retry requested')
    try {
      const res = await window.openchat.app.retryInit()
      if (res.ok) {
        rlog('init-error: retry ok')
        setInitError(null)
      } else {
        rlog(`init-error: retry failed: ${res.message ?? ''}`)
        setInitRetrying(false)
      }
    } catch (err) {
      rlog(`init-error: retry threw: ${err instanceof Error ? err.message : String(err)}`)
      setInitRetrying(false)
    }
  }

  return (
    <div className="app-container">
      <div className="init-error-screen">
        <div className="init-error-card">
          <div className="init-error-title">
            {initError.timedOut ? '初始化超时' : '初始化失败'}
          </div>
          <div className="init-error-message">{initError.message}</div>
          <button
            className="init-error-retry"
            onClick={handleRetry}
            disabled={initRetrying}
          >
            {initRetrying ? '正在重试…' : '重试初始化'}
          </button>
        </div>
      </div>
    </div>
  )
}
