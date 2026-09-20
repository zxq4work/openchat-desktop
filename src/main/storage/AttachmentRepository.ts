import { StorageService } from './StorageService'
import type { ImageDetail, MessageAttachment } from '../../shared/types/conversation'

// message_attachments 表访问层。
// 草稿阶段 message_id 为 null，发送后通过 bindToMessage 绑定。
export class AttachmentRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  create(att: MessageAttachment): void {
    const db = this.storage.database
    db.run(`
      INSERT INTO message_attachments (
        id, message_id, conversation_id, segment_id, type, mime_type,
        file_name, file_size, width, height, detail, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      att.id,
      att.messageId,
      att.conversationId,
      att.segmentId,
      att.type,
      att.mimeType,
      att.fileName,
      att.fileSize,
      att.width,
      att.height,
      att.detail,
      att.sha256,
      att.createdAt,
    ])
  }

  getById(id: string): MessageAttachment | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, message_id, conversation_id, segment_id, type, mime_type,
             file_name, file_size, width, height, detail, sha256, created_at
      FROM message_attachments WHERE id = ?
    `, [id])
    if (!result.length || !result[0].values.length) return null
    return this.rowToAttachment(result[0].values[0])
  }

  getByMessageId(messageId: string): MessageAttachment[] {
    return this.getByMessageIds([messageId]).get(messageId) ?? []
  }

  // 批量按 message_id 加载，供 MessageRepository 避免 N+1
  getByMessageIds(messageIds: string[]): Map<string, MessageAttachment[]> {
    const map = new Map<string, MessageAttachment[]>()
    if (messageIds.length === 0) return map
    const db = this.storage.database
    const placeholders = messageIds.map(() => '?').join(',')
    const result = db.exec(`
      SELECT id, message_id, conversation_id, segment_id, type, mime_type,
             file_name, file_size, width, height, detail, sha256, created_at
      FROM message_attachments
      WHERE message_id IN (${placeholders})
      ORDER BY created_at ASC
    `, messageIds)
    if (!result.length || !result[0].values.length) return map
    for (const row of result[0].values) {
      const att = this.rowToAttachment(row)
      if (!att.messageId) continue
      const list = map.get(att.messageId) ?? []
      list.push(att)
      map.set(att.messageId, list)
    }
    return map
  }

  bindToMessage(attachmentId: string, messageId: string, conversationId: string, segmentId: string): void {
    const db = this.storage.database
    db.run(
      `UPDATE message_attachments SET message_id = ?, conversation_id = ?, segment_id = ? WHERE id = ?`,
      [messageId, conversationId, segmentId, attachmentId]
    )
  }

  // 绑定某会话当前段中所有未绑定（message_id IS NULL）的草稿附件到指定消息。
  // 用于 sendMessage 时把用户选中的草稿一次性落库归属。
  bindDraftsToMessage(attachmentIds: string[], messageId: string, conversationId: string, segmentId: string): void {
    if (attachmentIds.length === 0) return
    const db = this.storage.database
    const placeholders = attachmentIds.map(() => '?').join(',')
    db.run(
      `UPDATE message_attachments
       SET message_id = ?, conversation_id = ?, segment_id = ?
       WHERE id IN (${placeholders}) AND message_id IS NULL`,
      [messageId, conversationId, segmentId, ...attachmentIds]
    )
  }

  setDetail(id: string, detail: ImageDetail): void {
    const db = this.storage.database
    db.run(`UPDATE message_attachments SET detail = ? WHERE id = ?`, [detail, id])
  }

  listByConversationId(conversationId: string): MessageAttachment[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, message_id, conversation_id, segment_id, type, mime_type,
             file_name, file_size, width, height, detail, sha256, created_at
      FROM message_attachments WHERE conversation_id = ?
    `, [conversationId])
    if (!result.length || !result[0].values.length) return []
    return result[0].values.map((row) => this.rowToAttachment(row))
  }

  // 未绑定到 message 的草稿附件（Composer 切换会话时恢复）
  listDrafts(conversationId: string): MessageAttachment[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, message_id, conversation_id, segment_id, type, mime_type,
             file_name, file_size, width, height, detail, sha256, created_at
      FROM message_attachments
      WHERE conversation_id = ? AND message_id IS NULL
      ORDER BY created_at ASC
    `, [conversationId])
    if (!result.length || !result[0].values.length) return []
    return result[0].values.map((row) => this.rowToAttachment(row))
  }

  listByConversationIds(conversationIds: string[]): MessageAttachment[] {
    if (conversationIds.length === 0) return []
    const db = this.storage.database
    const placeholders = conversationIds.map(() => '?').join(',')
    const result = db.exec(`
      SELECT id, message_id, conversation_id, segment_id, type, mime_type,
             file_name, file_size, width, height, detail, sha256, created_at
      FROM message_attachments WHERE conversation_id IN (${placeholders})
    `, conversationIds)
    if (!result.length || !result[0].values.length) return []
    return result[0].values.map((row) => this.rowToAttachment(row))
  }

  listAll(): MessageAttachment[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, message_id, conversation_id, segment_id, type, mime_type,
             file_name, file_size, width, height, detail, sha256, created_at
      FROM message_attachments
    `)
    if (!result.length || !result[0].values.length) return []
    return result[0].values.map((row) => this.rowToAttachment(row))
  }

  // 批量确认这些 message_id 中哪些在 messages 表中真实存在。
  // 供 cleanupOrphans 判定"是否仍绑定到有效 message"（messages 随会话级联删除）。
  existingMessageIds(messageIds: string[]): Set<string> {
    const set = new Set<string>()
    if (messageIds.length === 0) return set
    const db = this.storage.database
    const placeholders = messageIds.map(() => '?').join(',')
    const result = db.exec(`SELECT id FROM messages WHERE id IN (${placeholders})`, messageIds)
    if (!result.length || !result[0].values.length) return set
    for (const row of result[0].values) set.add(String(row[0]))
    return set
  }

  remove(id: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM message_attachments WHERE id = ?`, [id])
  }

  removeByConversationId(conversationId: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM message_attachments WHERE conversation_id = ?`, [conversationId])
  }

  removeByMessageId(messageId: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM message_attachments WHERE message_id = ?`, [messageId])
  }

  removeAll(): void {
    const db = this.storage.database
    db.run(`DELETE FROM message_attachments`)
  }

  private rowToAttachment(row: unknown[]): MessageAttachment {
    return {
      id: String(row[0]),
      messageId: row[1] ? String(row[1]) : null,
      conversationId: row[2] ? String(row[2]) : null,
      segmentId: row[3] ? String(row[3]) : null,
      // 第一版仅图片；type 列保留以便未来扩展 file/audio/video
      type: 'image',
      mimeType: String(row[5]),
      fileName: String(row[6]),
      fileSize: Number(row[7]),
      width: Number(row[8]),
      height: Number(row[9]),
      detail: (row[10] === 'low' || row[10] === 'high' ? row[10] : 'auto') as ImageDetail,
      sha256: String(row[11]),
      createdAt: Number(row[12]),
    }
  }
}
