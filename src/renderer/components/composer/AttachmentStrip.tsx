import React from 'react'
import type { MessageAttachment } from '../../../shared/types/conversation'
import { thumbnailUrl, formatFileSize } from '../../packages/attachmentUrl'

interface Props {
  attachments: MessageAttachment[]
  disabled?: boolean
  onRemove: (id: string) => void
  onPreview: (attachment: MessageAttachment) => void
}

// Composer 内的草稿图片条：缩略图 + 移除。点击缩略图查看原图。
export function AttachmentStrip({ attachments, disabled, onRemove, onPreview }: Props) {
  if (attachments.length === 0) return null

  return (
    <div className="attachment-strip">
      {attachments.map((att) => (
        <div key={att.id} className="attachment-strip-item" title={`${att.fileName} · ${formatFileSize(att.fileSize)}`}>
          <button
            type="button"
            className="attachment-strip-thumb"
            onClick={() => onPreview(att)}
            aria-label={`预览 ${att.fileName}`}
          >
            <img src={thumbnailUrl(att.id)} alt={att.fileName} loading="lazy" decoding="async" />
          </button>
          <button
            type="button"
            className="attachment-strip-remove"
            onClick={() => onRemove(att.id)}
            disabled={disabled}
            aria-label={`移除 ${att.fileName}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
