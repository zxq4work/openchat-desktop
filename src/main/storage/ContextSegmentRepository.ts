import { StorageService } from './StorageService'
import type { ContextSegment, SegmentReason } from '../../shared/types/conversation'

export class ContextSegmentRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  getByConversationId(conversationId: string): ContextSegment[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, sequence_no, reason,
             provider_thread_id, system_prompt_revision,
             system_prompt_snapshot, created_at
      FROM context_segments
      WHERE conversation_id = ?
      ORDER BY sequence_no ASC
    `, [conversationId])

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => this.rowToSegment(row))
  }

  getById(id: string): ContextSegment | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, sequence_no, reason,
             provider_thread_id, system_prompt_revision,
             system_prompt_snapshot, created_at
      FROM context_segments WHERE id = ?
    `, [id])

    if (!result.length || !result[0].values.length) return null

    return this.rowToSegment(result[0].values[0])
  }

  getNextSequence(conversationId: string): number {
    const db = this.storage.database
    const result = db.exec(`
      SELECT COALESCE(MAX(sequence_no), -1) + 1
      FROM context_segments WHERE conversation_id = ?
    `, [conversationId])

    if (!result.length || !result[0].values.length) return 0
    return Number(result[0].values[0][0])
  }

  create(segment: ContextSegment): void {
    const db = this.storage.database
    db.run(`
      INSERT INTO context_segments (
        id, conversation_id, sequence_no, reason,
        provider_thread_id, system_prompt_revision,
        system_prompt_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      segment.id,
      segment.conversationId,
      segment.sequence,
      segment.reason,
      segment.providerThreadId,
      segment.systemPromptRevision,
      segment.systemPromptSnapshot,
      segment.createdAt,
    ])
  }

  setProviderThreadId(id: string, threadId: string): void {
    const db = this.storage.database
    db.run(`UPDATE context_segments SET provider_thread_id = ? WHERE id = ?`, [threadId, id])
  }

  listProviderThreadIds(conversationId: string): string[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT provider_thread_id FROM context_segments
      WHERE conversation_id = ? AND provider_thread_id IS NOT NULL
    `, [conversationId])

    if (!result.length || !result[0].values.length) return []
    return result[0].values.map((row) => String(row[0]))
  }

  private rowToSegment(row: unknown[]): ContextSegment {
    return {
      id: String(row[0]),
      conversationId: String(row[1]),
      sequence: Number(row[2]),
      reason: String(row[3]) as SegmentReason,
      providerThreadId: row[4] ? String(row[4]) : null,
      systemPromptRevision: Number(row[5]),
      systemPromptSnapshot: String(row[6]),
      createdAt: Number(row[7]),
    }
  }
}