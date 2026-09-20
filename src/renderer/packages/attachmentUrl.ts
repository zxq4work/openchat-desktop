import type { MessageAttachment } from '../../shared/types/conversation'

// Renderer 只持有 attachmentId，通过受控 custom protocol 访问受管文件。
// 该协议由主进程按 DB 反查路径，renderer 无法构造任意磁盘路径。
export const ATTACHMENT_SCHEME = 'openchat-attachment'

export function thumbnailUrl(id: string): string {
  return `${ATTACHMENT_SCHEME}://thumbnail/${encodeURIComponent(id)}`
}

export function originalUrl(id: string): string {
  return `${ATTACHMENT_SCHEME}://original/${encodeURIComponent(id)}`
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function imageAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] {
  if (!attachments || attachments.length === 0) return []
  return attachments.filter((a) => a.type === 'image')
}
