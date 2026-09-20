import React from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useUiStore } from '../../stores/uiStore'
import { imageAttachments, thumbnailUrl } from '../../packages/attachmentUrl'

interface Props {
  message: Message
}

export function UserMessage({ message }: Props) {
  const openLightbox = useUiStore((s) => s.openLightbox)
  const images = imageAttachments(message.attachments)

  return (
    <div className="message user-message" data-message-id={message.id}>
      <div className="message-role">User</div>
      {images.length > 0 && (
        <div className={`message-image-grid message-image-grid--${images.length === 1 ? 'single' : 'multi'}`}>
          {images.map((att) => (
            <button
              key={att.id}
              type="button"
              className="message-image-cell"
              onClick={() => openLightbox(att)}
              aria-label={`查看原图 ${att.fileName}`}
            >
              <img src={thumbnailUrl(att.id)} alt={att.fileName} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      {message.content && <div className="message-content">{message.content}</div>}
    </div>
  )
}