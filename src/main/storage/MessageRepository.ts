import { StorageService } from './StorageService'
import type { Message, MessageStatus, ReasoningMeta } from '../../shared/types/conversation'
import { MESSAGE_PAGE_SIZE } from '../../shared/constants'

export class MessageRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  getByConversationId(conversationId: string, limit = MESSAGE_PAGE_SIZE, offset = 0): Message[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, created_at, updated_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `, [conversationId, limit, offset])

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => this.rowToMessage(row))
  }

  getBySegmentId(segmentId: string): Message[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, created_at, updated_at
      FROM messages
      WHERE segment_id = ?
      ORDER BY created_at ASC
    `, [segmentId])

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => this.rowToMessage(row))
  }

  getById(id: string): Message | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, created_at, updated_at
      FROM messages WHERE id = ?
    `, [id])

    if (!result.length || !result[0].values.length) return null

    return this.rowToMessage(result[0].values[0])
  }

  create(message: Message): void {
    const db = this.storage.database
    db.run(`
      INSERT INTO messages (
        id, conversation_id, segment_id, role, content, reasoning_json, status,
        model_id, reasoning_effort, provider_turn_id, provider_item_id,
        provider_payload_json, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      message.id,
      message.conversationId,
      message.segmentId,
      message.role,
      message.content,
      message.reasoningMeta ? JSON.stringify(message.reasoningMeta) : null,
      message.status,
      message.modelId,
      message.reasoningEffort,
      message.providerTurnId,
      message.providerItemId,
      message.providerPayloadJson ?? null,
      message.errorCode,
      message.errorMessage,
      message.createdAt,
      message.updatedAt,
    ])
  }

  updateContent(id: string, content: string): void {
    const db = this.storage.database
    db.run(`UPDATE messages SET content = ?, updated_at = ? WHERE id = ?`, [
      content,
      Date.now(),
      id,
    ])
  }

  updateReasoningMeta(id: string, meta: ReasoningMeta): void {
    const db = this.storage.database
    db.run(`UPDATE messages SET reasoning_json = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(meta),
      Date.now(),
      id,
    ])
  }

  updateStatus(id: string, status: MessageStatus): void {
    const db = this.storage.database
    db.run(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ?`, [
      status,
      Date.now(),
      id,
    ])
  }

  updateProviderIds(id: string, turnId: string, itemId: string): void {
    const db = this.storage.database
    db.run(
      `UPDATE messages SET provider_turn_id = ?, provider_item_id = ?, updated_at = ? WHERE id = ?`,
      [turnId, itemId, Date.now(), id]
    )
  }

  updateProviderItemId(id: string, itemId: string): void {
    const db = this.storage.database
    db.run(
      `UPDATE messages SET provider_item_id = ?, updated_at = ? WHERE id = ?`,
      [itemId, Date.now(), id]
    )
  }

  updateError(id: string, code: string, message: string): void {
    const db = this.storage.database
    db.run(
      `UPDATE messages SET error_code = ?, error_message = ?, status = 'failed', updated_at = ? WHERE id = ?`,
      [code, message, Date.now(), id]
    )
  }

  private rowToMessage(row: unknown[]): Message {
    const reasoningJson = row[5] ? String(row[5]) : null
    return {
      id: String(row[0]),
      conversationId: String(row[1]),
      segmentId: String(row[2]),
      role: String(row[3]) as 'user' | 'assistant',
      content: String(row[4]),
      reasoningMeta: reasoningJson ? JSON.parse(reasoningJson) as ReasoningMeta : null,
      status: String(row[6]) as MessageStatus,
      modelId: row[7] ? String(row[7]) : null,
      reasoningEffort: row[8] ? String(row[8]) : null,
      providerTurnId: row[9] ? String(row[9]) : null,
      providerItemId: row[10] ? String(row[10]) : null,
      providerPayloadJson: row[11] ? String(row[11]) : null,
      errorCode: row[12] ? String(row[12]) : null,
      errorMessage: row[13] ? String(row[13]) : null,
      createdAt: Number(row[14]),
      updatedAt: Number(row[15]),
    }
  }
}