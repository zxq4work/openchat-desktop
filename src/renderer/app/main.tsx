import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import 'katex/dist/katex.min.css'
import '../styles/global.css'

// 全局焦点模式跟踪：仅 Tab 键导航视为「键盘模式」，才显示 :focus-visible 轮廓。
// 鼠标点击（pointerdown）切回「鼠标模式」；Esc 等其他按键不改变模式，
// 因此关闭对话框后焦点恢复到触发按钮时不会误显示焦点边框。
function initFocusModeTracking(): void {
  const root = document.documentElement
  const setMode = (mode: 'mouse' | 'keyboard') => {
    root.dataset.focusMode = mode
  }
  setMode('mouse')
  window.addEventListener('pointerdown', () => setMode('mouse'))
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') setMode('keyboard')
  })
}
initFocusModeTracking()

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)