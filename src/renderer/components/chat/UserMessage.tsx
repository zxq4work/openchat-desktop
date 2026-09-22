import React, { useRef } from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useUiStore } from '../../stores/uiStore'
import { imageAttachments, thumbnailUrl } from '../../packages/attachmentUrl'
import { openMessageContextMenu, openImageContextMenu } from '../../packages/messageMenu'

interface Props {
  message: Message
}

export function UserMessage({ message }: Props) {
  const openLightbox = useUiStore((s) => s.openLightbox)
  const rootRef = useRef<HTMLDivElement>(null)
  const images = imageAttachments(message.attachments)
  // 图片生成参考图（usage=generation_input）加一个轻量「参考图」标签，
  // 与 Chat 图片输入区分；复用同一图片网格，不复制组件。
  const hasGenerationInput = images.some((a) => a.usage === 'generation_input')

  return (
    <div
      className="message user-message"
      data-message-id={message.id}
      ref={rootRef}
      onContextMenu={(e) => openMessageContextMenu(e, rootRef.current as HTMLElement, message.content)}
    >
      <div className="message-role">User</div>
      {images.length > 0 && (
        <div className="message-image-block">
          {hasGenerationInput && <div className="message-image-label">参考图</div>}
          <div className={`message-image-grid message-image-grid--${images.length === 1 ? 'single' : 'multi'}`}>
            {images.map((att) => (
              <button
                key={att.id}
                type="button"
                className="message-image-cell"
                onClick={() => openLightbox(att.id)}
                onContextMenu={(e) => openImageContextMenu(e, att.id, message.content)}
                aria-label={`查看原图 ${att.fileName}`}
              >
                <img
                  src={thumbnailUrl(att.id)}
                  alt={att.fileName}
                  width={att.width > 0 ? att.width : undefined}
                  height={att.height > 0 ? att.height : undefined}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ))}
          </div>
        </div>
      )}
      {message.content && <div className="message-content">{message.content}</div>}
    </div>
  )
}