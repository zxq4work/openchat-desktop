import type { AttachmentUsage, Message, MessageAttachment } from '../../shared/types/conversation'
import { thumbnailUrl, originalUrl } from './attachmentUrl'

// 当前会话「可预览图片」序列的一项。身份为 attachmentId（稳定），
// 而非数组下标 —— 会话内图片会随生成完成 / 删除而增减，下标不是稳定标识。
export interface ConversationPreviewImage {
  attachmentId: string
  messageId: string
  usage: AttachmentUsage
  originalUrl: string
  thumbnailUrl: string
  width: number
  height: number
  mimeType: string
  fileName: string
  fileSize: number
}

// 从当前会话的消息列表派生可预览图片序列。
// 纯函数：不访问 DB、不依赖 React，便于单测。
//
// 顺序保证：第一层 = 消息真实显示顺序（activeMessages 顺序），
// 第二层 = 同一消息内 attachment 的原有数组顺序。绝不按 attachmentId / createdAt 重排。
//
// 过滤规则：仅图片附件；排除非图片、未绑定 message 的草稿、以及缺失文件（width/height 均无效）的记录。
// pending / failed / stopped 占位不是 attachment，天然不在 activeMessages.attachments 中，无需额外排除。
export function deriveConversationPreviewImages(messages: Message[]): ConversationPreviewImage[] {
  const out: ConversationPreviewImage[] = []
  for (const message of messages) {
    const attachments = message.attachments as MessageAttachment[] | undefined
    if (!attachments || attachments.length === 0) continue
    for (const att of attachments) {
      if (att.type !== 'image') continue
      out.push({
        attachmentId: att.id,
        messageId: message.id,
        usage: att.usage,
        originalUrl: originalUrl(att.id),
        thumbnailUrl: thumbnailUrl(att.id),
        width: att.width,
        height: att.height,
        mimeType: att.mimeType,
        fileName: att.fileName,
        fileSize: att.fileSize,
      })
    }
  }
  return out
}

// 循环索引：上一张 / 下一张越界回绕。count <= 0 返回 -1。
export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1
  return (((index + delta) % count) + count) % count
}

// 单张草稿附件 → 预览项。草稿不在 activeMessages 中，预览时作为 1 元素序列打开，无导航。
export function toPreviewImage(att: MessageAttachment): ConversationPreviewImage {
  return {
    attachmentId: att.id,
    messageId: att.messageId ?? '',
    usage: att.usage,
    originalUrl: originalUrl(att.id),
    thumbnailUrl: thumbnailUrl(att.id),
    width: att.width,
    height: att.height,
    mimeType: att.mimeType,
    fileName: att.fileName,
    fileSize: att.fileSize,
  }
}
