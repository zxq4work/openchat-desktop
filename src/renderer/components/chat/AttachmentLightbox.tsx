import React, { useEffect, useState } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { originalUrl, formatFileSize } from '../../packages/attachmentUrl'
import { wrapIndex } from '../../packages/conversationPreviewImages'
import { copyAttachmentImage } from '../../packages/imageCopy'

// 应用内 Lightbox：展示原图与基础元数据，支持在「当前会话可预览图片序列」中前后切换。
// 由 uiStore.lightboxAttachmentId 驱动，序列来自：
//   - 消息图片：lightboxImages（ChatView 从 activeMessages 派生）
//   - 草稿图片：lightboxStandalone（单图，无导航）
//
// 切换图片只更新 lightboxAttachmentId —— 组件不卸载，src 改变，避免 overlay 闪烁 / 焦点丢失。
export function AttachmentLightbox() {
  const attachmentId = useUiStore((s) => s.lightboxAttachmentId)
  const images = useUiStore((s) => s.lightboxImages)
  const standalone = useUiStore((s) => s.lightboxStandalone)
  const closeLightbox = useUiStore((s) => s.closeLightbox)
  const prev = useUiStore((s) => s.lightboxPrev)
  const next = useUiStore((s) => s.lightboxNext)
  const openContextMenu = useUiStore((s) => s.openContextMenu)
  const [saving, setSaving] = useState(false)

  // 草稿预览：序列退化为该单图，无导航。
  const seq = standalone ? [standalone] : images
  const count = seq.length
  const index = attachmentId ? seq.findIndex((img) => img.attachmentId === attachmentId) : -1
  // 当前图片身份已不在序列中（会话切换 / 图片被删）→ 关闭 Lightbox。
  const dangling = !!attachmentId && !standalone && index < 0
  const current = index >= 0 ? seq[index] : null
  const hasNav = !standalone && count > 1 && index >= 0

  const fileName = current?.fileName ?? ''
  const width = current?.width ?? 0
  const height = current?.height ?? 0
  const fileSize = current?.fileSize ?? 0

  useEffect(() => {
    if (dangling) closeLightbox()
  }, [dangling, closeLightbox])

  useEffect(() => {
    if (!attachmentId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeLightbox()
      } else if (hasNav && e.key === 'ArrowLeft') {
        prev()
      } else if (hasNav && e.key === 'ArrowRight') {
        next()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [attachmentId, hasNav, closeLightbox, prev, next])

  // 相邻图片预加载：仅左右各一张 original，避免一次性 decode 整会话大图。
  useEffect(() => {
    if (!hasNav) return
    for (const delta of [-1, 1]) {
      const neighbor = seq[wrapIndex(index, delta, count)]
      if (neighbor) {
        const img = new Image()
        img.src = neighbor.originalUrl
      }
    }
  }, [hasNav, index, count, seq])

  if (!attachmentId) return null

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (saving) return
    setSaving(true)
    try {
      await window.openchat.attachments.save(attachmentId)
    } finally {
      setSaving(false)
    }
  }

  // 右键真正图片元素：复制图片。overlay / 按钮 / 序号不弹菜单。
  const handleImageContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const id = attachmentId
    openContextMenu(e.clientX, e.clientY, [
      { id: 'copy-image', label: '复制图片', onClick: () => { void copyAttachmentImage(id) } },
    ])
  }

  return (
    <div className="attachment-lightbox" onClick={closeLightbox}>
      {/* 图片 stage：只承载图片，独立于 viewport controls。
          图片在 stage 可用区域内居中；stage 的 padding 为 close / prev / next / footer 预留空间。 */}
      <div className="attachment-lightbox-stage">
        {hasNav && (
          <button
            className="attachment-lightbox-nav attachment-lightbox-nav--prev"
            onClick={(e) => { e.stopPropagation(); prev() }}
            aria-label="上一张"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}

        <img
          className="attachment-lightbox-image"
          src={originalUrl(attachmentId)}
          alt={fileName}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={handleImageContextMenu}
          decoding="async"
        />

        {hasNav && (
          <button
            className="attachment-lightbox-nav attachment-lightbox-nav--next"
            onClick={(e) => { e.stopPropagation(); next() }}
            aria-label="下一张"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>

      <button
        className="attachment-lightbox-close"
        onClick={closeLightbox}
        aria-label="关闭"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>

      {/* footer：视口层 UI，固定在窗口底部，位置与图片尺寸完全无关。
          title/media 属性在窄窗口下可被压缩/隐藏，save 始终保留。
          点击 footer 内部不触发 overlay 关闭（stopPropagation），避免误关预览。 */}
      <div className="attachment-lightbox-footer" title={fileName} onClick={(e) => e.stopPropagation()}>
        <div className="attachment-lightbox-footer-left">
          <span className="attachment-lightbox-name">{fileName}</span>
          {width > 0 && height > 0 && (
            <>
              <span className="attachment-lightbox-sep">·</span>
              <span className="attachment-lightbox-dims">{width} × {height}</span>
            </>
          )}
          {fileSize > 0 && (
            <>
              <span className="attachment-lightbox-sep attachment-lightbox-sep--size">·</span>
              <span className="attachment-lightbox-size">{formatFileSize(fileSize)}</span>
            </>
          )}
        </div>
        {hasNav && <span className="attachment-lightbox-counter">{index + 1} / {count}</span>}
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
