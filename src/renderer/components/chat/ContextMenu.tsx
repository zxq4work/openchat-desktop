import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../../stores/uiStore'

// 通用右键菜单：由 uiStore.contextMenu 唯一驱动，全局最多一个。
// 视觉完全复用既有 .context-menu / .context-menu-item 样式，不引入第二套菜单外观。
// 调用方提供 items（label + onClick），组件只负责定位、边界修正、关闭。
const VIEWPORT_MARGIN = 8

export function ContextMenu() {
  const menu = useUiStore((s) => s.contextMenu)
  const close = useUiStore((s) => s.closeContextMenu)
  const menuRef = useRef<HTMLDivElement>(null)
  // 边界修正后的实际位置：初始取右键点，测量尺寸后再夹取到视口内。
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  // 每次打开重置为右键点（在 paint 前），随后由 layout effect 夹取。
  useLayoutEffect(() => {
    if (!menu.visible) return
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    setPos({
      x: Math.min(Math.max(menu.x, VIEWPORT_MARGIN), maxX),
      y: Math.min(Math.max(menu.y, VIEWPORT_MARGIN), maxY),
    })
  }, [menu.visible, menu.x, menu.y, menu.items])

  // 点击菜单外关闭
  useEffect(() => {
    if (!menu.visible) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menu.visible, close])

  // Esc 关闭。捕获阶段 stopPropagation，使同一次 Esc 不再穿透到 Lightbox 的关闭监听。
  useEffect(() => {
    if (!menu.visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [menu.visible, close])

  if (!menu.visible) return null

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item) => (
        <button
          key={item.id}
          className="context-menu-item"
          disabled={item.disabled}
          onClick={() => {
            item.onClick()
            close()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
