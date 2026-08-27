import { StorageService } from './StorageService'
import type { Message, MessageStatus, ReasoningMeta, WebSearchResultItem } from '../../shared/types/conversation'
import { MESSAGE_PAGE_SIZE } from '../../shared/constants'

export class MessageRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  getByConversationId(conversationId: string, limit = MESSAGE_PAGE_SIZE, offset = 0): Message[] {
    const db = this.storage.database
    // 先取最新的 N 条，再按 created_at ASC 排序，保证 UI 显示顺序正确
    // 子查询：ORDER BY created_at DESC 取最新，外层 ORDER BY created_at ASC 恢复时间顺序
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, web_search_results_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, created_at, updated_at
      FROM (
        SELECT * FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      )
      ORDER BY created_at ASC
    `, [conversationId, limit, offset])

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => this.rowToMessage(row))
  }

  getBySegmentId(segmentId: string): Message[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, web_search_results_json, status,
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
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, web_search_results_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, created_at, updated_at
      FROM messages WHERE id = ?
    `, [id])

    if (!result.length || !result[0].values.length) return null

    return this.rowToMessage(result[0].values[0])
  }

  create(message: Message): void {
    const db = this.storage.database
    const params = [
      message.id,
      message.conversationId,
      message.segmentId,
      message.role,
      message.content,
      message.reasoningMeta ? JSON.stringify(message.reasoningMeta) : null,
      message.webSearchResults ? JSON.stringify(message.webSearchResults) : null,
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
    ]
    try {
      db.run(`
        INSERT INTO messages (
          id, conversation_id, segment_id, role, content, reasoning_json, web_search_results_json, status,
          model_id, reasoning_effort, provider_turn_id, provider_item_id,
          provider_payload_json, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, params)
    } catch (e) {
      const types = params.map((p, i) => `[${i}]=${typeof p}(${p === undefined ? 'UNDEFINED' : p === null ? 'null' : String(p).slice(0, 30)})`)
      console.error('[DB] create params:', types.join(' '))
      throw e
    }
  }

  updateContent(id: string, content: string): void {
    const db = this.storage.database
    try {
      db.run(`UPDATE messages SET content = ?, updated_at = ? WHERE id = ?`, [
        content,
        Date.now(),
        id,
      ])
    } catch (e) {
      console.error('[DB] updateContent params:', { id: typeof id, content: typeof content, idVal: id, contentVal: content?.slice(0, 50) })
      throw e
    }
  }

  updateReasoningMeta(id: string, meta: ReasoningMeta): void {
    const db = this.storage.database
    try {
      db.run(`UPDATE messages SET reasoning_json = ?, updated_at = ? WHERE id = ?`, [
        JSON.stringify(meta),
        Date.now(),
        id,
      ])
    } catch (e) {
      console.error('[DB] updateReasoningMeta params:', { id: typeof id, meta: typeof meta, idVal: id })
      throw e
    }
  }

  updateWebSearchResults(id: string, results: WebSearchResultItem[]): void {
    const db = this.storage.database
    try {
      db.run(`UPDATE messages SET web_search_results_json = ?, updated_at = ? WHERE id = ?`, [
        JSON.stringify(results),
        Date.now(),
        id,
      ])
    } catch (e) {
      console.error('[DB] updateWebSearchResults params:', { id: typeof id, results: typeof results, idVal: id, resultsLen: results?.length })
      throw e
    }
  }

  updateStatus(id: string, status: MessageStatus): void {
    const db = this.storage.database
    try {
      db.run(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ?`, [
        status,
        Date.now(),
        id,
      ])
    } catch (e) {
      console.error('[DB] updateStatus params:', { id: typeof id, status: typeof status, idVal: id, statusVal: status })
      throw e
    }
  }

  updateProviderIds(id: string, turnId: string, itemId: string): void {
    const db = this.storage.database
    try {
      db.run(
        `UPDATE messages SET provider_turn_id = ?, provider_item_id = ?, updated_at = ? WHERE id = ?`,
        [turnId, itemId, Date.now(), id]
      )
    } catch (e) {
      console.error('[DB] updateProviderIds params:', { id: typeof id, turnId: typeof turnId, itemId: typeof itemId, idVal: id, turnIdVal: turnId, itemIdVal: itemId })
      throw e
    }
  }

  updateProviderItemId(id: string, itemId: string): void {
    const db = this.storage.database
    try {
      db.run(
        `UPDATE messages SET provider_item_id = ?, updated_at = ? WHERE id = ?`,
        [itemId, Date.now(), id]
      )
    } catch (e) {
      console.error('[DB] updateProviderItemId params:', { id: typeof id, itemId: typeof itemId, idVal: id, itemIdVal: itemId })
      throw e
    }
  }

  updateProviderPayload(id: string, payload: Record<string, unknown>): void {
    const db = this.storage.database
    try {
      db.run(
        `UPDATE messages SET provider_payload_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(payload), Date.now(), id]
      )
    } catch (e) {
      console.error('[DB] updateProviderPayload params:', { id: typeof id, payload: typeof payload, idVal: id })
      throw e
    }
  }

  updateError(id: string, code: string, message: string): void {
    const db = this.storage.database
    try {
      db.run(
        `UPDATE messages SET error_code = ?, error_message = ?, status = 'failed', updated_at = ? WHERE id = ?`,
        [code, message, Date.now(), id]
      )
    } catch (e) {
      console.error('[DB] updateError params:', { id: typeof id, code: typeof code, message: typeof message, idVal: id, codeVal: code, msgVal: message })
      throw e
    }
  }

  private rowToMessage(row: unknown[]): Message {
    const reasoningJson = row[5] ? String(row[5]) : null
    const webSearchResultsJson = row[6] ? String(row[6]) : null
    return {
      id: String(row[0]),
      conversationId: String(row[1]),
      segmentId: String(row[2]),
      role: String(row[3]) as 'user' | 'assistant',
      content: String(row[4]),
      reasoningMeta: reasoningJson ? JSON.parse(reasoningJson) as ReasoningMeta : null,
      webSearchResults: webSearchResultsJson ? JSON.parse(webSearchResultsJson) : null,
      status: String(row[7]) as MessageStatus,
      modelId: row[8] ? String(row[8]) : null,
      reasoningEffort: row[9] ? String(row[9]) : null,
      providerTurnId: row[10] ? String(row[10]) : null,
      providerItemId: row[11] ? String(row[11]) : null,
      providerPayloadJson: row[12] ? String(row[12]) : null,
      errorCode: row[13] ? String(row[13]) : null,
      errorMessage: row[14] ? String(row[14]) : null,
      createdAt: Number(row[15]),
      updatedAt: Number(row[16]),
    }
  }
}