import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatShortcut, type ShortcutSpec } from '../packages/shortcut'

// 最小共享 Tooltip：hover / focus-visible 时展示「动作名 + 快捷键」。
// 之所以自建而不是用原生 title：title 的延迟与样式不可控，且 macOS/Windows 表现不一致。
// 之所以不用第三方库：本仓库已有足够样式能力，不值得为此引入依赖。
//
// 交互节奏（模拟原生 title 的「停留片刻才出现、一动就没」）：
//   - 鼠标停留满 TOOLTIP_POINTER_DELAY_MS 才出现；
//   - 出现后鼠标一移动就立即消失（不再跟随指针）；
//   - 未出现前的 mousemove 只更新将要使用的锚点坐标，不重置计时。
//
// 定位有两种 anchor：
//   - pointer：鼠标 hover → 贴着鼠标指针附近出现（入口很宽时不会跑到元素最右端）。
//   - element：键盘 Tab focus → 无鼠标坐标，退回触发元素 rect 定位。
// 两种都做 viewport collision：右侧/底部空间不足时翻到左/上，保证完整留在窗口内。
//
// 布局安全：宿主用 display:contents —— 它不产生盒子，子元素仍按原父级（flex 行）排布，
// 因此包裹按钮不改变既有布局。浮层用 position:fixed，不受祖先 overflow / 定位影响。

// 鼠标 hover：停留片刻再出现，模拟 HTML 原生 title 的体验（并非与其数值完全一致）。
const TOOLTIP_POINTER_DELAY_MS = 700
// 键盘 focus：无需模拟 title 的「防误触」延迟，稍短一些，避免 Tab 后长时间无反馈。
const TOOLTIP_KEYBOARD_DELAY_MS = 450
// 与指针的偏移，避免浮层正好盖住指针。
const POINTER_DX = 12
const POINTER_DY = 14
// 与视口边缘的最小留白。
const VIEWPORT_PAD = 8

type Anchor =
  | { kind: 'pointer'; x: number; y: number }
  | { kind: 'element'; rect: DOMRect }

export interface TooltipProps {
  // 动作名（主文本），如「搜索会话」。
  label: string
  // 快捷键 spec；不传则只显示动作名。
  shortcut?: ShortcutSpec
  children: React.ReactNode
}

export function Tooltip({ label, shortcut, children }: TooltipProps) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 当前 anchor 与鼠标坐标都存在 ref 里：mousemove 期间直接改 style，不触发 re-render。
  const anchorRef = useRef<Anchor | null>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  // 浮层尺寸缓存：出现时测一次，mousemove 复用，避免每帧强制 reflow。
  const sizeRef = useRef<{ w: number; h: number } | null>(null)
  const [visible, setVisible] = useState(false)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // 触发元素 = 宿主的第一个元素子节点（宿主本身 display:contents 无盒子）
  const triggerEl = () => hostRef.current?.firstElementChild as HTMLElement | null

  const hide = () => {
    clearTimer()
    anchorRef.current = null
    sizeRef.current = null
    setVisible(false)
  }

  // 按当前 anchor 计算并写入 fixed 坐标（含 viewport collision）。只碰 style，不 setState。
  const applyPosition = () => {
    const tip = tipRef.current
    const anchor = anchorRef.current
    if (!tip || !anchor) return

    const w = sizeRef.current?.w ?? tip.offsetWidth
    const h = sizeRef.current?.h ?? tip.offsetHeight
    let left: number
    let top: number

    if (anchor.kind === 'pointer') {
      left = anchor.x + POINTER_DX
      top = anchor.y + POINTER_DY
      // 右侧空间不足 → 翻到指针左侧
      if (left + w > window.innerWidth - VIEWPORT_PAD) left = anchor.x - POINTER_DX - w
      // 底部空间不足 → 翻到指针上方
      if (top + h > window.innerHeight - VIEWPORT_PAD) top = anchor.y - POINTER_DY - h
    } else {
      const r = anchor.rect
      left = r.right + POINTER_DX
      top = r.top + r.height / 2 - h / 2
      if (left + w > window.innerWidth - VIEWPORT_PAD) left = r.left - POINTER_DX - w
      if (top + h > window.innerHeight - VIEWPORT_PAD) top = window.innerHeight - VIEWPORT_PAD - h
    }

    // 兜底：无论哪种 anchor 都不许溢出，最后统一夹住。
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - VIEWPORT_PAD - w))
    top = Math.max(VIEWPORT_PAD, Math.min(top, window.innerHeight - VIEWPORT_PAD - h))

    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }

  // 首次出现时，等浮层挂载后再测量、定位（useLayoutEffect 在 paint 前执行，不会闪）
  useLayoutEffect(() => {
    if (!visible) return
    const tip = tipRef.current
    if (tip) sizeRef.current = { w: tip.offsetWidth, h: tip.offsetHeight }
    applyPosition()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, label])

  // mode：'pointer' 用于鼠标 hover；'element' 用于键盘 focus。
  const show = (mode: 'pointer' | 'element') => {
    clearTimer()
    const delay = mode === 'pointer' ? TOOLTIP_POINTER_DELAY_MS : TOOLTIP_KEYBOARD_DELAY_MS
    timerRef.current = setTimeout(() => {
      if (mode === 'pointer') {
        const p = pointerRef.current
        const trigger = triggerEl()
        // 无鼠标坐标（极端情况）则退回元素定位
        if (p) anchorRef.current = { kind: 'pointer', x: p.x, y: p.y }
        else if (trigger) anchorRef.current = { kind: 'element', rect: trigger.getBoundingClientRect() }
        else return
      } else {
        const trigger = triggerEl()
        if (!trigger) return
        anchorRef.current = { kind: 'element', rect: trigger.getBoundingClientRect() }
      }
      setVisible(true)
    }, delay)
  }

  useEffect(() => clearTimer, [])

  return (
    <span
      ref={hostRef}
      className="oc-tooltip-host"
      onMouseEnter={(e) => {
        pointerRef.current = { x: e.clientX, y: e.clientY }
        show('pointer')
      }}
      onMouseMove={(e) => {
        pointerRef.current = { x: e.clientX, y: e.clientY }
        // 已显示后鼠标一动就立即消失（模拟原生 title：不跟随指针）。
        // 未显示时这里只更新待用锚点坐标，绝不重启计时，避免轻微移动导致永不出现。
        if (visible) hide()
      }}
      onMouseLeave={hide}
      onClick={hide}
      onFocus={(e) => {
        // 仅键盘焦点（focus-visible）触发；鼠标点击造成的聚焦不弹 Tooltip
        if ((e.target as HTMLElement).matches(':focus-visible')) show('element')
      }}
      onBlur={hide}
    >
      {children}
      {visible && (
        <span
          ref={tipRef}
          className="oc-tooltip"
          role="tooltip"
          style={{ left: -9999, top: -9999 }}
        >
          <span className="oc-tooltip-label">{label}</span>
          {shortcut && <kbd className="oc-tooltip-kbd">{formatShortcut(shortcut)}</kbd>}
        </span>
      )}
    </span>
  )
}
