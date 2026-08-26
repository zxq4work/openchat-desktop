import { StorageService } from './StorageService'

export class SettingsRepository {
  private storage: StorageService

  constructor(storage: StorageService) {
    this.storage = storage
  }

  get(key: string): string | null {
    const db = this.storage.database
    const result = db.exec(`SELECT value FROM settings WHERE key = ?`, [key])
    if (!result.length || !result[0].values.length) return null
    return String(result[0].values[0][0])
  }

  set(key: string, value: string): void {
    const db = this.storage.database
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value])
    this.storage.save().catch((err) => console.error('Failed to persist settings:', err))
  }

  remove(key: string): void {
    const db = this.storage.database
    db.run(`DELETE FROM settings WHERE key = ?`, [key])
    this.storage.save().catch((err) => console.error('Failed to persist settings:', err))
  }
}