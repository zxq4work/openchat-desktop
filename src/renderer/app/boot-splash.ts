import { SPLASH_CLEANUP_TIMEOUT_MS } from '../../shared/constants'

// 主进程发送 FINISH_SPLASH 后调用，执行 Splash → App 的 DOM 切换。
// 先显示 root（visibility:visible），再开始 Splash opacity 淡出。
// 这样 fade 过程中 App 已经可见，不会出现空白。
let finished = false

export function finishBootSplash(): void {
  if (finished) return
  finished = true

  document.documentElement.classList.add('app-ready')

  const splash = document.getElementById('boot-splash')
  if (!splash) return

  let removed = false
  const cleanup = () => {
    if (removed) return
    removed = true
    splash.remove()
  }

  splash.addEventListener('transitionend', cleanup, { once: true })

  // fallback：transitionend 不触发时（prefers-reduced-motion 等）
  window.setTimeout(cleanup, SPLASH_CLEANUP_TIMEOUT_MS)
}