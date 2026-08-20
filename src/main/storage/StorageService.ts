import initSqlJs, { Database, SqlJsStatic } from 'sql.js'
import * as fs from 'fs'
import * as path from 'path'

export class StorageService {
  private db: Database | null = null
  private dbPath: string
  private sqlPromise: Promise<SqlJsStatic>

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.sqlPromise = initSqlJs()
  }

  async init(): Promise<void> {
    const SQL = await this.sqlPromise

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath)
      this.db = new SQL.Database(buffer)
      if (this.runMigrations()) {
        await this.save()
      }
    } else {
      this.db = new SQL.Database()
      this.createSchema()
      await this.save()
    }
  }

  private runMigrations(): boolean {
    if (!this.db) return false

    // 迁移：检查 provider_payload_json 列是否存在
    const cols = this.db.exec("PRAGMA table_info(messages)")
    const columnNames = cols.length > 0 && cols[0].values
      ? cols[0].values.map((row) => String(row[1]))
      : []

    let changed = false
    if (!columnNames.includes('provider_payload_json')) {
      this.db.run("ALTER TABLE messages ADD COLUMN provider_payload_json TEXT")
      changed = true
    }
    if (!columnNames.includes('reasoning_json')) {
      this.db.run("ALTER TABLE messages ADD COLUMN reasoning_json TEXT")
      changed = true
    }

    // 迁移：conversations 表 use_model_instructions 列
    const convCols = this.db.exec("PRAGMA table_info(conversations)")
    const convColumnNames = convCols.length > 0 && convCols[0].values
      ? convCols[0].values.map((row) => String(row[1]))
      : []
    if (!convColumnNames.includes('use_model_instructions')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN use_model_instructions INTEGER NOT NULL DEFAULT 1")
      changed = true
    }
    return changed
  }

  get database(): Database {
    if (!this.db) {
      throw new Error('Database not initialized')
    }
    return this.db
  }

  async save(): Promise<void> {
    if (!this.db) return

    const dir = path.dirname(this.dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const data = this.db.export()
    const buffer = Buffer.from(data)
    const tmpPath = this.dbPath + '.tmp'
    const bakPath = this.dbPath + '.bak'

    fs.writeFileSync(tmpPath, buffer)
    const fd = fs.openSync(tmpPath, 'r+')
    fs.fsyncSync(fd)
    fs.closeSync(fd)

    if (fs.existsSync(this.dbPath)) {
      fs.renameSync(this.dbPath, bakPath)
    }

    fs.renameSync(tmpPath, this.dbPath)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private createSchema(): void {
    if (!this.db) return

    this.db.run(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        system_prompt_revision INTEGER NOT NULL DEFAULT 0,
        default_model_id TEXT,
        default_reasoning_effort TEXT,
        current_segment_id TEXT NOT NULL,
        use_model_instructions INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE context_segments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        reason TEXT NOT NULL,
        provider_thread_id TEXT,
        system_prompt_revision INTEGER NOT NULL,
        system_prompt_snapshot TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id)
          REFERENCES conversations(id)
          ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX idx_segments_conversation_seq
        ON context_segments(conversation_id, sequence_no);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning_json TEXT,
        status TEXT NOT NULL,
        model_id TEXT,
        reasoning_effort TEXT,
        provider_turn_id TEXT,
        provider_item_id TEXT,
        provider_payload_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id)
          REFERENCES conversations(id)
          ON DELETE CASCADE,
        FOREIGN KEY(segment_id)
          REFERENCES context_segments(id)
          ON DELETE CASCADE
      );

      CREATE INDEX idx_messages_conversation_created
        ON messages(conversation_id, created_at);

      CREATE INDEX idx_messages_segment_created
        ON messages(segment_id, created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE model_cache (
        model_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }
}