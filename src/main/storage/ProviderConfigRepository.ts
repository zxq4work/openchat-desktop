import { StorageService } from './StorageService'
import type { CustomProviderConfig, ToolCallingMode } from '../../shared/types/provider'
import { randomUUID } from 'crypto'

export class ProviderConfigRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  list(): CustomProviderConfig[] {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, name, protocol, base_url, api_key, models,
             models_path, chat_completions_path, responses_path,
             extra_headers, tool_calling, created_at, updated_at
      FROM provider_configs
      ORDER BY created_at ASC
    `)

    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => this.rowToConfig(row))
  }

  listSafe(): Array<Omit<CustomProviderConfig, 'apiKey'> & { hasApiKey: boolean }> {
    return this.list().map((c) => {
      const { apiKey, ...rest } = c
      return {
        ...rest,
        hasApiKey: !!apiKey,
      }
    })
  }

  getById(id: string): CustomProviderConfig | null {
    const db = this.storage.database
    const result = db.exec(`
      SELECT id, name, protocol, base_url, api_key, models,
             models_path, chat_completions_path, responses_path,
             extra_headers, tool_calling, created_at, updated_at
      FROM provider_configs WHERE id = ?
    `, [id])

    if (!result.length || !result[0].values.length) return null

    return this.rowToConfig(result[0].values[0])
  }

  create(config: Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>): CustomProviderConfig {
    const now = Date.now()
    const id = randomUUID()
    const db = this.storage.database

    const fullConfig: CustomProviderConfig = {
      ...config,
      id,
      createdAt: now,
      updatedAt: now,
    }

    db.run(`
      INSERT INTO provider_configs (
        id, name, protocol, base_url, api_key, models,
        models_path, chat_completions_path, responses_path,
        extra_headers, tool_calling, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      fullConfig.name,
      fullConfig.protocol,
      fullConfig.baseUrl,
      fullConfig.apiKey,
      JSON.stringify(fullConfig.models),
      fullConfig.modelsPath ?? null,
      fullConfig.chatCompletionsPath ?? null,
      fullConfig.responsesPath ?? null,
      fullConfig.extraHeaders ? JSON.stringify(fullConfig.extraHeaders) : null,
      fullConfig.toolCalling,
      now,
      now,
    ])

    return fullConfig
  }

  delete(id: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM provider_configs WHERE id = ?`, [id])
  }

  update(id: string, updates: Partial<Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>>): void {
    const db = this.storage.database
    const now = Date.now()

    const sets: string[] = []
    const values: Array<string | number | null> = []

    if (updates.name !== undefined) {
      sets.push('name = ?')
      values.push(updates.name)
    }
    if (updates.protocol !== undefined) {
      sets.push('protocol = ?')
      values.push(updates.protocol)
    }
    if (updates.baseUrl !== undefined) {
      sets.push('base_url = ?')
      values.push(updates.baseUrl)
    }
    if (updates.apiKey !== undefined) {
      sets.push('api_key = ?')
      values.push(updates.apiKey)
    }
    if (updates.models !== undefined) {
      sets.push('models = ?')
      values.push(JSON.stringify(updates.models))
    }
    if (updates.modelsPath !== undefined) {
      sets.push('models_path = ?')
      values.push(updates.modelsPath || null)
    }
    if (updates.chatCompletionsPath !== undefined) {
      sets.push('chat_completions_path = ?')
      values.push(updates.chatCompletionsPath || null)
    }
    if (updates.responsesPath !== undefined) {
      sets.push('responses_path = ?')
      values.push(updates.responsesPath || null)
    }
    if (updates.toolCalling !== undefined) {
      sets.push('tool_calling = ?')
      values.push(updates.toolCalling)
    }
    if (updates.extraHeaders !== undefined) {
      sets.push('extra_headers = ?')
      values.push(updates.extraHeaders ? JSON.stringify(updates.extraHeaders) : null)
    }

    if (sets.length === 0) return

    sets.push('updated_at = ?')
    values.push(now)
    values.push(id)

    db.run(`UPDATE provider_configs SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  private rowToConfig(row: unknown[]): CustomProviderConfig {
    let extraHeaders: Record<string, string> | undefined
    const headersStr = row[9] ? String(row[9]) : null
    if (headersStr) {
      try {
        extraHeaders = JSON.parse(headersStr) as Record<string, string>
      } catch {
        // ignore malformed
      }
    }

    let models: string[] = []
    try {
      const parsed = JSON.parse(String(row[5]))
      models = Array.isArray(parsed) ? parsed : []
    } catch {
      models = []
    }

    return {
      id: String(row[0]),
      name: String(row[1]),
      protocol: String(row[2]) as CustomProviderConfig['protocol'],
      baseUrl: String(row[3]),
      apiKey: String(row[4]),
      models,
      modelsPath: row[6] ? String(row[6]) : undefined,
      chatCompletionsPath: row[7] ? String(row[7]) : undefined,
      responsesPath: row[8] ? String(row[8]) : undefined,
      extraHeaders,
      toolCalling: String(row[10]) as ToolCallingMode,
      createdAt: Number(row[11]),
      updatedAt: Number(row[12]),
    }
  }
}