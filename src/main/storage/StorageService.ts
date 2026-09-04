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
    if (!convColumnNames.includes('web_search_enabled')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0")
      changed = true
    }

    const msgCols = this.db.exec("PRAGMA table_info(messages)")
    const msgColumnNames = msgCols.length > 0 && msgCols[0].values
      ? msgCols[0].values.map((row) => String(row[1]))
      : []
    if (!msgColumnNames.includes('web_search_results_json')) {
      this.db.run("ALTER TABLE messages ADD COLUMN web_search_results_json TEXT")
      changed = true
    }
    if (!msgColumnNames.includes('web_search_error')) {
      this.db.run("ALTER TABLE messages ADD COLUMN web_search_error TEXT")
      changed = true
    }

    // 迁移：conversations 表 provider_config_id 列
    if (!convColumnNames.includes('provider_config_id')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN provider_config_id TEXT")
      changed = true
    }

    // 迁移：conversations 表 codex_search_mode 列（Codex 搜索模式：hosted | standalone）
    if (!convColumnNames.includes('codex_search_mode')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN codex_search_mode TEXT NOT NULL DEFAULT 'hosted'")
      changed = true
    }

    // 迁移：conversations 表 search_engine 列（自定义 Provider 搜索引擎：bing | baidu | google）
    if (!convColumnNames.includes('search_engine')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN search_engine TEXT NOT NULL DEFAULT 'bing'")
      changed = true
    }

    // 迁移：provider_configs 表
    const tables = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_configs'")
    if (!tables.length || !tables[0].values.length) {
      this.db.run(`
        CREATE TABLE provider_configs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          protocol TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL,
          models TEXT NOT NULL DEFAULT '[]',
          models_path TEXT,
          chat_completions_path TEXT,
          responses_path TEXT,
          extra_headers TEXT,
          tool_calling TEXT NOT NULL DEFAULT 'auto',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      changed = true
    }

    // 迁移：model_id → models 数组，并移除旧的 model_id 列
    const provCols = this.db.exec("PRAGMA table_info(provider_configs)")
    if (provCols.length > 0 && provCols[0].values) {
      const colNames = provCols[0].values.map((row) => String(row[1]))
      const hasModelId = colNames.includes('model_id')
      const hasModels = colNames.includes('models')

      // 先补齐可能缺失的列（旧表可能只有 model_id，没有这些路径列）
      const ensureCols: Array<[string, string]> = [
        ['models', "TEXT NOT NULL DEFAULT '[]'"],
        ['models_path', 'TEXT'],
        ['chat_completions_path', 'TEXT'],
        ['responses_path', 'TEXT'],
        ['extra_headers', 'TEXT'],
        ['tool_calling', "TEXT NOT NULL DEFAULT 'auto'"],
      ]
      for (const [col, def] of ensureCols) {
        if (!colNames.includes(col)) {
          this.db.run(`ALTER TABLE provider_configs ADD COLUMN ${col} ${def}`)
        }
      }

      if (hasModelId) {
        // SQLite 旧版本不支持 DROP COLUMN，采用重建表的方式移除 model_id
        this.db.run('BEGIN TRANSACTION')
        try {
          // 回填 models（旧 model_id → [model_id]）
          const rows = this.db.exec('SELECT id, model_id FROM provider_configs')
          if (rows.length > 0 && rows[0].values.length > 0) {
            for (const row of rows[0].values) {
              const id = String(row[0])
              const modelId = row[1] ? String(row[1]) : ''
              if (modelId) {
                const models = JSON.stringify([modelId])
                this.db.run('UPDATE provider_configs SET models = ? WHERE id = ?', [models, id])
              }
            }
          }

          this.db.run(`
            CREATE TABLE provider_configs_new (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              protocol TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key TEXT NOT NULL,
              models TEXT NOT NULL DEFAULT '[]',
              models_path TEXT,
              chat_completions_path TEXT,
              responses_path TEXT,
              extra_headers TEXT,
              tool_calling TEXT NOT NULL DEFAULT 'auto',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          `)
          this.db.run(`
            INSERT INTO provider_configs_new (
              id, name, protocol, base_url, api_key, models,
              models_path, chat_completions_path, responses_path,
              extra_headers, tool_calling, created_at, updated_at
            )
            SELECT id, name, protocol, base_url, api_key, models,
                   models_path, chat_completions_path, responses_path,
                   extra_headers, tool_calling, created_at, updated_at
            FROM provider_configs
          `)
          this.db.run('DROP TABLE provider_configs')
          this.db.run('ALTER TABLE provider_configs_new RENAME TO provider_configs')
          this.db.run('COMMIT')
          changed = true
        } catch (err) {
          this.db.run('ROLLBACK')
          throw err
        }
      } else if (!hasModels) {
        // 理论上 ensureCols 已补齐 models，这里仅标记 changed
        changed = true
      }
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
        web_search_enabled INTEGER NOT NULL DEFAULT 0,
        codex_search_mode TEXT NOT NULL DEFAULT 'hosted',
        search_engine TEXT NOT NULL DEFAULT 'bing',
        provider_config_id TEXT,
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
        web_search_results_json TEXT,
        status TEXT NOT NULL,
        model_id TEXT,
        reasoning_effort TEXT,
        provider_turn_id TEXT,
        provider_item_id TEXT,
        provider_payload_json TEXT,
        error_code TEXT,
        error_message TEXT,
        web_search_error TEXT,
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

      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        models TEXT NOT NULL DEFAULT '[]',
        models_path TEXT,
        chat_completions_path TEXT,
        responses_path TEXT,
        extra_headers TEXT,
        tool_calling TEXT NOT NULL DEFAULT 'auto',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }
}