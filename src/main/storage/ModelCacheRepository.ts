import { StorageService } from './StorageService'
import type { ModelInfo } from '../../shared/types/model'

export class ModelCacheRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  getAll(): ModelInfo[] {
    const db = this.storage.database
    const result = db.exec(`SELECT model_id, json FROM model_cache`)
    if (!result.length || !result[0].values.length) return []

    return result[0].values.map((row) => JSON.parse(String(row[1])) as ModelInfo)
  }

  replaceAll(models: ModelInfo[]): void {
    const db = this.storage.database
    db.run(`DELETE FROM model_cache`)
    const now = Date.now()
    for (const model of models) {
      db.run(`INSERT INTO model_cache (model_id, json, updated_at) VALUES (?, ?, ?)`, [
        model.id,
        JSON.stringify(model),
        now,
      ])
    }
  }
}