// 极轻量的启动入口：只做早期同步主题设置，然后立即加载 React 应用。

// 早期同步读取用户主题设置，让 Splash 首帧尽量匹配用户自定义主题
const THEME_KEY = 'openchat.themeMode'
const stored = localStorage.getItem(THEME_KEY)
if (stored === 'light' || stored === 'dark') {
  document.documentElement.setAttribute('data-theme', stored)
} else {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

// macOS opacity gate 握手：先注册 BOOT_WINDOW_SHOWN listener，
// 再通知 Main Process listener 已 ready。顺序不能反过来。
// listener 在这里注册，不依赖 React mount，避免 IPC race。
let windowShownHandled = false
window.openchat.app.onWindowShown(() => {
  if (windowShownHandled) return
  windowShownHandled = true
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.openchat.app.notifySplashPainted()
    })
  })
})

window.openchat.app.notifyOpacityGateReady()

// 立即加载 React 应用
void import('./main')

export {}