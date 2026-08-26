import React, { useEffect, useRef } from 'react'

interface Props {
  visible: boolean
  x: number
  y: number
  onClose: () => void
}

export function MessageListContextMenu({ visible, x, y, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [visible, onClose])

  if (!visible) return null

  const handleCopy = () => {
    const selection = window.getSelection()
    const text = selection?.toString()
    if (text) {
      navigator.clipboard.writeText(text)
    }
    onClose()
  }

  const handleSearchInBrowser = () => {
    const selection = window.getSelection()
    const text = selection?.toString().trim()
    if (text) {
      window.openchat.openExternal(text)
    }
    onClose()
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
    >
      <button className="context-menu-item" onClick={handleCopy}>复制</button>
      <button className="context-menu-item" onClick={handleSearchInBrowser}>在浏览器中搜索</button>
    </div>
  )
}