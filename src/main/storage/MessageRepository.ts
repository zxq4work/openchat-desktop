import { StorageService } from './StorageService'
import type { Message, MessageStatus, ReasoningDisplayMode, ReasoningMeta, WebSearchResultItem } from '../../shared/types/conversation'
import { cleanCitationText } from '../services/ai/CitationParser'

export class MessageRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  getByConversationId(conversationId: string): Message[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, reasoning_text, reasoning_display_mode, web_search_results_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, web_search_error, created_at, updated_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `, [conversationId])

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => this.rowToMessage(row))
  }

  getBySegmentId(segmentId: string): Message[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, reasoning_text, reasoning_display_mode, web_search_results_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, web_search_error, created_at, updated_at
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
      SELECT id, conversation_id, segment_id, role, content, reasoning_json, reasoning_text, reasoning_display_mode, web_search_results_json, status,
             model_id, reasoning_effort, provider_turn_id, provider_item_id,
             provider_payload_json, error_code, error_message, web_search_error, created_at, updated_at
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
      message.reasoningText ?? null,
      message.reasoningDisplayMode ?? 'none',
      message.webSearchResults ? JSON.stringify(message.webSearchResults) : null,
      message.status,
      message.modelId,
      message.reasoningEffort,
      message.providerTurnId,
      message.providerItemId,
      message.providerPayloadJson ?? null,
      message.errorCode,
      message.errorMessage,
      message.webSearchError ?? null,
      message.createdAt,
      message.updatedAt,
    ]
    try {
      db.run(`
        INSERT INTO messages (
          id, conversation_id, segment_id, role, content, reasoning_json, reasoning_text, reasoning_display_mode, web_search_results_json, status,
          model_id, reasoning_effort, provider_turn_id, provider_item_id,
          provider_payload_json, error_code, error_message, web_search_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  updateReasoningText(id: string, text: string): void {
    const db = this.storage.database
    try {
      db.run(`UPDATE messages SET reasoning_text = ?, updated_at = ? WHERE id = ?`, [
        text,
        Date.now(),
        id,
      ])
    } catch (e) {
      console.error('[DB] updateReasoningText params:', { id: typeof id, textLen: text?.length, idVal: id })
      throw e
    }
  }

  // 300ms debounce 版本的 reasoningText 写入，避免每个 delta 都触发 sqlite IO。
  // 同时保存 pending text，便于结束路径强制 flush 最新文本。
  private reasoningTextTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private reasoningTextPending = new Map<string, string>()

  updateReasoningTextDebounced(id: string, text: string): void {
    this.reasoningTextPending.set(id, text)
    const existing = this.reasoningTextTimers.get(id)
    if (existing) clearTimeout(existing)
    this.reasoningTextTimers.set(id, setTimeout(() => {
      this.reasoningTextTimers.delete(id)
      this.reasoningTextPending.delete(id)
      this.updateReasoningText(id, text)
    }, 300))
  }

  // 立即 flush 指定 id 的未落库 reasoningText（completion 前调用）
  flushReasoningText(id: string, text: string): void {
    const existing = this.reasoningTextTimers.get(id)
    if (existing) {
      clearTimeout(existing)
      this.reasoningTextTimers.delete(id)
    }
    this.reasoningTextPending.delete(id)
    this.updateReasoningText(id, text)
  }

  // 立即 flush 指定 assistantMessageId 的 pending debounce reasoningText。
  // generation finally 只 flush 自己的 id，不跨 generation 污染。
  flushPendingReasoningText(id: string): void {
    const timer = this.reasoningTextTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.reasoningTextTimers.delete(id)
    }
    const text = this.reasoningTextPending.get(id)
    if (text !== undefined) {
      this.reasoningTextPending.delete(id)
      this.updateReasoningText(id, text)
    }
  }

  // 全局 flush：仅用于 storage close / 应用 shutdown
  flushAllPendingReasoningText(): void {
    for (const [id, timer] of this.reasoningTextTimers) {
      clearTimeout(timer)
    }
    this.reasoningTextTimers.clear()
    for (const [id, text] of this.reasoningTextPending) {
      this.updateReasoningText(id, text)
    }
    this.reasoningTextPending.clear()
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

  updateWebSearchError(id: string, error: string): void {
    const db = this.storage.database
    try {
      db.run(
        `UPDATE messages SET web_search_error = ?, updated_at = ? WHERE id = ?`,
        [error, Date.now(), id]
      )
    } catch (e) {
      console.error('[DB] updateWebSearchError params:', { id: typeof id, error: typeof error, idVal: id, errorVal: error })
      throw e
    }
  }

  private rowToMessage(row: unknown[]): Message {
    const reasoningJson = row[5] ? String(row[5]) : null
    const reasoningText = row[6] ? String(row[6]) : null
    const reasoningDisplayMode = (row[7] ? String(row[7]) : 'none') as ReasoningDisplayMode
    const webSearchResultsJson = row[8] ? String(row[8]) : null
    const rawContent = String(row[4])
    // 兼容清理旧数据中的 citation marker
    const cleanedContent = cleanCitationText(rawContent).cleanText
    return {
      id: String(row[0]),
      conversationId: String(row[1]),
      segmentId: String(row[2]),
      role: String(row[3]) as 'user' | 'assistant',
      content: cleanedContent,
      reasoningMeta: reasoningJson ? JSON.parse(reasoningJson) as ReasoningMeta : null,
      reasoningText: reasoningText,
      reasoningDisplayMode: reasoningDisplayMode,
      webSearchResults: webSearchResultsJson ? JSON.parse(webSearchResultsJson) : null,
      status: String(row[9]) as MessageStatus,
      modelId: row[10] ? String(row[10]) : null,
      reasoningEffort: row[11] ? String(row[11]) : null,
      providerTurnId: row[12] ? String(row[12]) : null,
      providerItemId: row[13] ? String(row[13]) : null,
      providerPayloadJson: row[14] ? String(row[14]) : null,
      errorCode: row[15] ? String(row[15]) : null,
      errorMessage: row[16] ? String(row[16]) : null,
      webSearchError: row[17] ? String(row[17]) : null,
      createdAt: Number(row[18]),
      updatedAt: Number(row[19]),
    }
  }
}