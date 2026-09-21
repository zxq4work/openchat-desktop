import React, { useEffect, useState } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { originalUrl, formatFileSize } from '../../packages/attachmentUrl'

// 应用内 Lightbox：展示原图与基础元数据。Esc / 点击空白 / 点关闭按钮关闭。
// 由 uiStore.lightboxAttachment 驱动，草稿与历史消息共用同一实例。
export function AttachmentLightbox() {
  const attachment = useUiStore((s) => s.lightboxAttachment)
  const closeLightbox = useUiStore((s) => s.closeLightbox)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!attachment) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [attachment, closeLightbox])

  if (!attachment) return null

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (saving) return
    setSaving(true)
    try {
      await window.openchat.attachments.save(attachment.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="attachment-lightbox" onClick={closeLightbox}>
      <button
        className="attachment-lightbox-close"
        onClick={closeLightbox}
        aria-label="关闭"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
      <img
        className="attachment-lightbox-image"
        src={originalUrl(attachment.id)}
        alt={attachment.fileName}
        onClick={(e) => e.stopPropagation()}
        decoding="async"
      />
      <div className="attachment-lightbox-meta">
        <span className="attachment-lightbox-name">{attachment.fileName}</span>
        <span>{attachment.width} × {attachment.height}</span>
        <span>{formatFileSize(attachment.fileSize)}</span>
        <button
          className="attachment-lightbox-save"
          onClick={handleSave}
          disabled={saving}
          aria-label="保存图片"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
