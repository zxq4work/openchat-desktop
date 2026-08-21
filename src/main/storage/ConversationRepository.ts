import { StorageService } from './StorageService'
import type { Conversation, ConversationSummary } from '../../shared/types/conversation'

export class ConversationRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  listSummaries(): ConversationSummary[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT c.id, c.title, c.updated_at,
        (SELECT m.content FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC LIMIT 1) AS preview
      FROM conversations c
      ORDER BY c.updated_at DESC
    `)

    if (!result.length || !result[0].values.length) return []

    const summaries: ConversationSummary[] = []
    for (const row of result[0].values) {
      summaries.push({
        id: String(row[0]),
        title: String(row[1]),
        updatedAt: Number(row[2]),
        preview: row[3] ? String(row[3]).slice(0, 100) : '',
      })
    }
    return summaries
  }

  getById(id: string): Conversation | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, title, system_prompt, system_prompt_revision,
             default_model_id, default_reasoning_effort,
             current_segment_id, use_model_instructions, web_search_enabled, created_at, updated_at
      FROM conversations WHERE id = ?
    `, [id])

    if (!result.length || !result[0].values.length) return null

    const row = result[0].values[0]
    return this.rowToConversation(row)
  }

  create(conversation: Conversation): void {
    const db = this.storage.database
    db.run(`
      INSERT INTO conversations (
        id, title, system_prompt, system_prompt_revision,
        default_model_id, default_reasoning_effort,
        current_segment_id, use_model_instructions, web_search_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      conversation.id,
      conversation.title,
      conversation.systemPrompt,
      conversation.systemPromptRevision,
      conversation.defaultModelId,
      conversation.defaultReasoningEffort,
      conversation.currentSegmentId,
      conversation.useModelInstructions ? 1 : 0,
      conversation.webSearchEnabled ? 1 : 0,
      conversation.createdAt,
      conversation.updatedAt,
    ])
  }

  rename(id: string, title: string): void {
    const db = this.storage.database
    db.run(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`, [
      title,
      Date.now(),
      id,
    ])
  }

  updateSystemPrompt(id: string, systemPrompt: string, revision: number): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET system_prompt = ?, system_prompt_revision = ?, updated_at = ? WHERE id = ?`,
      [systemPrompt, revision, Date.now(), id]
    )
  }

  updateModel(id: string, modelId: string): void {
    const db = this.storage.database
    db.run(`UPDATE conversations SET default_model_id = ?, updated_at = ? WHERE id = ?`, [
      modelId,
      Date.now(),
      id,
    ])
  }

  updateEffort(id: string, effort: string): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET default_reasoning_effort = ?, updated_at = ? WHERE id = ?`,
      [effort, Date.now(), id]
    )
  }

  updateCurrentSegment(id: string, segmentId: string): void {
    const db = this.storage.database
    db.run(`UPDATE conversations SET current_segment_id = ?, updated_at = ? WHERE id = ?`, [
      segmentId,
      Date.now(),
      id,
    ])
  }

  updateUseModelInstructions(id: string, useModelInstructions: boolean): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET use_model_instructions = ?, updated_at = ? WHERE id = ?`,
      [useModelInstructions ? 1 : 0, Date.now(), id]
    )
  }

  updateWebSearchEnabled(id: string, webSearchEnabled: boolean): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET web_search_enabled = ?, updated_at = ? WHERE id = ?`,
      [webSearchEnabled ? 1 : 0, Date.now(), id]
    )
  }

  remove(id: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM conversations WHERE id = ?`, [id])
  }

  private rowToConversation(row: unknown[]): Conversation {
    return {
      id: String(row[0]),
      title: String(row[1]),
      systemPrompt: String(row[2]),
      systemPromptRevision: Number(row[3]),
      defaultModelId: row[4] ? String(row[4]) : null,
      defaultReasoningEffort: row[5] ? String(row[5]) : null,
      currentSegmentId: String(row[6]),
      useModelInstructions: row[7] ? Number(row[7]) === 1 : false,
      webSearchEnabled: row[8] ? Number(row[8]) === 1 : false,
      createdAt: Number(row[9]),
      updatedAt: Number(row[10]),
    }
  }
}