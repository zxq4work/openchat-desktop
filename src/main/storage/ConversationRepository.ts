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
      SELECT c.id, c.type, c.title, c.updated_at,
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
        type: row[1] === 'image_generation' ? 'image_generation' : 'chat',
        title: String(row[2]),
        updatedAt: Number(row[3]),
        preview: row[4] ? String(row[4]).slice(0, 100) : '',
      })
    }
    return summaries
  }

  // 全局会话搜索用：按 id 列表批量取回标题 / updatedAt / 预览。
  // 搜索结果按会话聚合后，只有命中会话才需要这些摘要字段（一次查询，避免 N+1）。
  getSummariesByIds(ids: string[]): ConversationSummary[] {
    if (ids.length === 0) return []
    const db = this.storage.database
    const placeholders = ids.map(() => '?').join(', ')
    const result = db.exec(`
      SELECT id, type, title, updated_at FROM conversations WHERE id IN (${placeholders})
    `, ids)

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => ({
      id: String(row[0]),
      type: row[1] === 'image_generation' ? 'image_generation' : 'chat',
      title: String(row[2]),
      updatedAt: Number(row[3]),
      preview: '',
    }))
  }

  getById(id: string): Conversation | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, type, title, system_prompt, system_prompt_revision,
             default_model_id, default_reasoning_effort,
             current_segment_id, use_model_instructions, web_search_enabled,
             codex_search_mode, search_engine, provider_config_id,
             default_image_size, default_image_quality, default_image_background,
             provider_name_snapshot, model_name_snapshot,
             created_at, updated_at
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
        id, type, title, system_prompt, system_prompt_revision,
        default_model_id, default_reasoning_effort,
        current_segment_id, use_model_instructions, web_search_enabled,
        codex_search_mode, search_engine, provider_config_id,
        default_image_size, default_image_quality, default_image_background,
        provider_name_snapshot, model_name_snapshot,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      conversation.id,
      conversation.type,
      conversation.title,
      conversation.systemPrompt,
      conversation.systemPromptRevision,
      conversation.defaultModelId,
      conversation.defaultReasoningEffort,
      conversation.currentSegmentId,
      conversation.useModelInstructions ? 1 : 0,
      conversation.webSearchEnabled ? 1 : 0,
      conversation.codexSearchMode,
      conversation.searchEngine,
      conversation.providerConfigId ?? null,
      conversation.defaultImageSize ?? null,
      conversation.defaultImageQuality ?? null,
      conversation.defaultImageBackground ?? null,
      conversation.providerNameSnapshot ?? null,
      conversation.modelNameSnapshot ?? null,
      conversation.createdAt,
      conversation.updatedAt,
    ])
  }

  // 会话锁定为图片生成类型（首次选择 Image Generations Provider/Model 时调用）
  lockImageGeneration(id: string, providerConfigId: string | null): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET type = 'image_generation', provider_config_id = ?, updated_at = ? WHERE id = ?`,
      [providerConfigId ?? null, Date.now(), id]
    )
  }

  // 空会话类型切换（chat ↔ image_generation），仅在无消息时允许
  updateType(id: string, type: Conversation['type']): void {
    const db = this.storage.database
    db.run(`UPDATE conversations SET type = ?, updated_at = ? WHERE id = ?`, [type, Date.now(), id])
  }

  updateImageDefaults(id: string, size: string | null, quality: string | null, background: string | null): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET default_image_size = ?, default_image_quality = ?, default_image_background = ?, updated_at = ? WHERE id = ?`,
      [size ?? null, quality ?? null, background ?? null, Date.now(), id]
    )
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

  updateProviderConfigId(id: string, providerConfigId: string | null): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET provider_config_id = ?, updated_at = ? WHERE id = ?`,
      [providerConfigId ?? null, Date.now(), id]
    )
  }

  // 写入 binding 名称快照（Provider/Model 失效时的展示兜底）。
  // 仅记录「绑定时看到的名称」，不作为发送配置使用。
  updateBindingSnapshot(id: string, providerName: string | null, modelName: string | null): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET provider_name_snapshot = ?, model_name_snapshot = ?, updated_at = ? WHERE id = ?`,
      [providerName ?? null, modelName ?? null, Date.now(), id]
    )
  }

  updateCodexSearchMode(id: string, mode: 'hosted' | 'standalone'): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET codex_search_mode = ?, updated_at = ? WHERE id = ?`,
      [mode, Date.now(), id]
    )
  }

  updateSearchEngine(id: string, engine: 'bing' | 'baidu' | 'google'): void {
    const db = this.storage.database
    db.run(
      `UPDATE conversations SET search_engine = ?, updated_at = ? WHERE id = ?`,
      [engine, Date.now(), id]
    )
  }

  remove(id: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM conversations WHERE id = ?`, [id])
  }

  removeAll(): void {
    const db = this.storage.database
    db.run(`DELETE FROM conversations`)
  }

  private rowToConversation(row: unknown[]): Conversation {
    return {
      id: String(row[0]),
      type: row[1] === 'image_generation' ? 'image_generation' : 'chat',
      title: String(row[2]),
      systemPrompt: String(row[3]),
      systemPromptRevision: Number(row[4]),
      defaultModelId: row[5] ? String(row[5]) : null,
      defaultReasoningEffort: row[6] ? String(row[6]) : null,
      currentSegmentId: String(row[7]),
      useModelInstructions: row[8] ? Number(row[8]) === 1 : false,
      webSearchEnabled: row[9] ? Number(row[9]) === 1 : false,
      codexSearchMode: (row[10] === 'standalone' ? 'standalone' : 'hosted') as 'hosted' | 'standalone',
      searchEngine: (row[11] === 'baidu' || row[11] === 'google' ? row[11] : 'bing') as 'bing' | 'baidu' | 'google',
      providerConfigId: row[12] ? String(row[12]) : null,
      defaultImageSize: row[13] ? String(row[13]) : null,
      defaultImageQuality: row[14] ? String(row[14]) : null,
      defaultImageBackground: row[15] ? String(row[15]) : null,
      providerNameSnapshot: row[16] ? String(row[16]) : null,
      modelNameSnapshot: row[17] ? String(row[17]) : null,
      createdAt: Number(row[18]),
      updatedAt: Number(row[19]),
    }
  }
}