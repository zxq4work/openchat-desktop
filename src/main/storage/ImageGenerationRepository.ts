import { StorageService } from './StorageService'
import type { ImageGeneration, ImageGenerationStatus, ImageGenerationOperation } from '../../shared/types/conversation'

// image_generations 表访问层。
// 记录"为什么、如何生成"（prompt / 参数 / provider / model / 状态），
// 文件本身归 message_attachments 描述。
export class ImageGenerationRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  create(gen: ImageGeneration): void {
    const db = this.storage.database
    db.run(`
      INSERT INTO image_generations (
        id, conversation_id, prompt_message_id, result_message_id,
        provider_config_id, model_id, prompt, size, quality, background,
        output_format, n, operation, input_image_count, revised_prompt,
        status, error_code, error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      gen.id,
      gen.conversationId,
      gen.promptMessageId,
      gen.resultMessageId,
      gen.providerConfigId,
      gen.modelId,
      gen.prompt,
      gen.size,
      gen.quality,
      gen.background,
      gen.outputFormat,
      gen.n,
      gen.operation,
      gen.inputImageCount,
      gen.revisedPrompt,
      gen.status,
      gen.errorCode,
      gen.errorMessage,
      gen.createdAt,
      gen.completedAt,
    ])
  }

  // 生成完成后回填结果（result message / revised_prompt / 状态）
  complete(id: string, resultMessageId: string, revisedPrompt: string | null): void {
    const db = this.storage.database
    db.run(
      `UPDATE image_generations SET result_message_id = ?, revised_prompt = ?, status = 'completed', completed_at = ? WHERE id = ?`,
      [resultMessageId, revisedPrompt ?? null, Date.now(), id]
    )
  }

  setStatus(id: string, status: ImageGenerationStatus, errorCode: string | null = null, errorMessage: string | null = null): void {
    const db = this.storage.database
    db.run(
      `UPDATE image_generations SET status = ?, error_code = ?, error_message = ?, completed_at = ? WHERE id = ?`,
      [status, errorCode, errorMessage, Date.now(), id]
    )
  }

  getByConversationId(conversationId: string): ImageGeneration[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, prompt_message_id, result_message_id,
             provider_config_id, model_id, prompt, size, quality, background,
             output_format, n, operation, input_image_count, revised_prompt,
             status, error_code, error_message, created_at, completed_at
      FROM image_generations WHERE conversation_id = ?
      ORDER BY created_at ASC
    `, [conversationId])
    if (!result.length || !result[0].values.length) return []
    return result[0].values.map((row) => this.rowToGeneration(row))
  }

  getById(id: string): ImageGeneration | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, conversation_id, prompt_message_id, result_message_id,
             provider_config_id, model_id, prompt, size, quality, background,
             output_format, n, operation, input_image_count, revised_prompt,
             status, error_code, error_message, created_at, completed_at
      FROM image_generations WHERE id = ?
    `, [id])
    if (!result.length || !result[0].values.length) return null
    return this.rowToGeneration(result[0].values[0])
  }

  removeByConversationId(conversationId: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM image_generations WHERE conversation_id = ?`, [conversationId])
  }

  removeAll(): void {
    const db = this.storage.database
    db.run(`DELETE FROM image_generations`)
  }

  private rowToGeneration(row: unknown[]): ImageGeneration {
    const rawStatus = String(row[15])
    const status: ImageGenerationStatus =
      rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
        ? rawStatus
        : 'pending'
    const rawOperation = String(row[12])
    const operation: ImageGenerationOperation = rawOperation === 'image_to_image' ? 'image_to_image' : 'text_to_image'
    return {
      id: String(row[0]),
      conversationId: String(row[1]),
      promptMessageId: row[2] ? String(row[2]) : null,
      resultMessageId: row[3] ? String(row[3]) : null,
      providerConfigId: row[4] ? String(row[4]) : null,
      modelId: row[5] ? String(row[5]) : null,
      prompt: String(row[6]),
      size: row[7] ? String(row[7]) : null,
      quality: row[8] ? String(row[8]) : null,
      background: row[9] ? String(row[9]) : null,
      outputFormat: row[10] ? String(row[10]) : null,
      n: Number(row[11]) || 1,
      operation,
      inputImageCount: Number(row[13]) || 0,
      revisedPrompt: row[14] ? String(row[14]) : null,
      status,
      errorCode: row[16] ? String(row[16]) : null,
      errorMessage: row[17] ? String(row[17]) : null,
      createdAt: Number(row[18]),
      completedAt: row[19] ? Number(row[19]) : null,
    }
  }
}
