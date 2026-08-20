import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'

export interface DropdownOption {
  value: string
  label: string
}

interface DropdownProps {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  ariaLabel?: string
}

interface MenuPosition {
  top?: number
  bottom?: number
  left: number
  minWidth: number
  maxHeight: number
  maxWidth: number
}

const MENU_GAP = 6
const EDGE_PADDING = 8
const MAX_MENU_HEIGHT = 320

export function Dropdown({
  value,
  options,
  onChange,
  className,
  placeholder,
  ariaLabel,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition>({
    left: 0,
    minWidth: 0,
    maxHeight: MAX_MENU_HEIGHT,
    maxWidth: 0,
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value)

  const close = useCallback(() => setOpen(false), [])

  const openMenu = useCallback(() => {
    const trigger = rootRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const maxWidth = window.innerWidth - EDGE_PADDING * 2

    // 下方空间不足且上方更宽时，向上翻转
    const placeAbove = spaceBelow < spaceAbove

    const next: MenuPosition = {
      left: Math.max(EDGE_PADDING, Math.min(rect.left, window.innerWidth - rect.width - EDGE_PADDING)),
      minWidth: rect.width,
      maxHeight: Math.max(
        60,
        Math.min(MAX_MENU_HEIGHT, (placeAbove ? spaceAbove : spaceBelow) - MENU_GAP - EDGE_PADDING)
      ),
      maxWidth,
    }

    if (placeAbove) {
      next.bottom = window.innerHeight - rect.top + MENU_GAP
    } else {
      next.top = rect.bottom + MENU_GAP
    }

    setPosition(next)
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      close()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const handleResize = () => close()
    // 触发按钮所在容器滚动时（如设置弹窗），菜单会与按钮错位，直接关闭
    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      close()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, close])

  const handleSelect = (v: string) => {
    onChange(v)
    close()
  }

  return (
    <div
      ref={rootRef}
      className={`dropdown${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
    >
      <button
        type="button"
        className="dropdown-trigger"
        onClick={() => (open ? close() : openMenu())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={`dropdown-value${selected ? '' : ' placeholder'}`}>
          {selected ? selected.label : placeholder ?? '请选择'}
        </span>
        <span className="dropdown-caret" aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="dropdown-menu"
            role="listbox"
            style={{
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              minWidth: position.minWidth,
              maxHeight: position.maxHeight,
              maxWidth: position.maxWidth,
            }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                className={`dropdown-item${opt.value === value ? ' selected' : ''}`}
                onClick={() => handleSelect(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
