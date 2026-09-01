import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from '../hooks/useDialogStack'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [loading, setLoading] = useState(false)

  // 确认框弹出时降权背后的 Settings Modal，保证所有确认框表现一致
  useEffect(() => {
    if (!open) return
    const settingsDialog = document.querySelector<HTMLElement>('.settings-dialog')
    settingsDialog?.classList.add('has-confirm')
    return () => {
      settingsDialog?.classList.remove('has-confirm')
    }
  }, [open])

  useDialogStack(onCancel, open)

  if (!open) return null

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
    }
  }

  return createPortal(
    <div className="confirm-layer">
      <div className="dialog confirm-dialog">
        <h3>{title}</h3>
        <p className="dialog-subtitle">{message}</p>
        <div className="dialog-actions">
          <button className="btn-cancel" onClick={onCancel} disabled={loading}>
            {cancelText}
          </button>
          <button className="btn-logout" onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <>
                <span className="btn-spinner" />
                {confirmText}
              </>
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
