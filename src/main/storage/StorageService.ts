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

  private tableExists(name: string): boolean {
    const result = this.db?.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name])
    return !!result && result.length > 0 && result[0].values.length > 0
  }

  private hasForeignKey(table: string, fromColumn: string): boolean {
    const result = this.db?.exec(`PRAGMA foreign_key_list(${table})`)
    if (!result || !result.length || !result[0].values.length) return false
    return result[0].values.some((row) => String(row[3]) === fromColumn)
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
    if (!columnNames.includes('reasoning_text')) {
      this.db.run("ALTER TABLE messages ADD COLUMN reasoning_text TEXT")
      changed = true
    }
    if (!columnNames.includes('reasoning_display_mode')) {
      this.db.run("ALTER TABLE messages ADD COLUMN reasoning_display_mode TEXT NOT NULL DEFAULT 'none'")
      changed = true
    }

    // Backfill 旧数据（幂等，每次迁移都执行）：列已存在但值为 'none' 的旧消息
    // 需要根据 reasoning_text / reasoning_json 推断正确 displayMode。
    // 不能放在上面的 if 里——列可能在更早的版本已创建，导致 backfill 永远不执行。
    this.db.run(`
      UPDATE messages SET reasoning_display_mode = 'live'
      WHERE reasoning_text IS NOT NULL AND reasoning_text != ''
        AND reasoning_display_mode = 'none'
    `)
    // summary backfill 需要逐个检查 reasoning_json 是否有实际 summary 内容，
    // 不能简单用 reasoning_json IS NOT NULL 判断（可能为 {} 或 available=false）。
    // 必须解析 JSON 确认 summary 数组非空。
    const summaryBackfillResult = this.db.exec(
      `SELECT id, reasoning_json FROM messages WHERE reasoning_display_mode = 'none' AND reasoning_json IS NOT NULL AND reasoning_json != ''`
    )
    if (summaryBackfillResult.length > 0 && summaryBackfillResult[0].values.length > 0) {
      const stmt = this.db.prepare("UPDATE messages SET reasoning_display_mode = 'summary' WHERE id = ?")
      for (const row of summaryBackfillResult[0].values) {
        const id = String(row[0])
        const json = String(row[1])
        try {
          const parsed = JSON.parse(json) as { available?: boolean; summary?: string[] }
          const hasSummary = parsed.summary && Array.isArray(parsed.summary) && parsed.summary.length > 0 && parsed.summary.some((s: string) => s.trim().length > 0)
          if (hasSummary) {
            stmt.run([id])
          }
        } catch {
          // 无效 JSON，跳过
        }
      }
      stmt.free()
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

    // 迁移：conversations 表 type 列（chat | image_generation）。
    // 旧库已有会话一律回填 'chat'，保证历史聊天完全无感。
    if (!convColumnNames.includes('type')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'chat'")
      changed = true
    }

    // 迁移：conversations 表默认图片参数（仅 image_generation 会话使用）
    if (!convColumnNames.includes('default_image_size')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN default_image_size TEXT")
      changed = true
    }
    if (!convColumnNames.includes('default_image_quality')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN default_image_quality TEXT")
      changed = true
    }
    if (!convColumnNames.includes('default_image_background')) {
      this.db.run("ALTER TABLE conversations ADD COLUMN default_image_background TEXT")
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

    // 迁移：provider_configs 表 image_input 列（自定义 Provider 是否支持图片输入）
    if (this.tableExists('provider_configs')) {
      const pcCols = this.db.exec("PRAGMA table_info(provider_configs)")
      const pcNames = pcCols.length > 0 && pcCols[0].values ? pcCols[0].values.map((row) => String(row[1])) : []
      if (!pcNames.includes('image_input')) {
        this.db.run("ALTER TABLE provider_configs ADD COLUMN image_input INTEGER NOT NULL DEFAULT 0")
        changed = true
      }
      // 迁移：image_generations_path 列（Image Generations Provider 的请求路径）
      if (!pcNames.includes('image_generations_path')) {
        this.db.run("ALTER TABLE provider_configs ADD COLUMN image_generations_path TEXT")
        changed = true
      }
      // 迁移：image_generation_profile_json 列（Image Generation 参数能力 Profile）。
      // 旧 Provider 无值 → 读取时回退到最小集（只发送 model/prompt/n），
      // 不假定 OpenAI 兼容，避免把历史第三方 Provider 误判为完整兼容。
      if (!pcNames.includes('image_generation_profile_json')) {
        this.db.run("ALTER TABLE provider_configs ADD COLUMN image_generation_profile_json TEXT")
        changed = true
      }
    }

    // 迁移：message_attachments 表（图片输入附件）。旧数据库无此表 → 自动创建。
    // 非破坏性：既有 messages 行不需要重写，读取时 attachments 缺省为 []。
    if (!this.tableExists('message_attachments')) {
      this.db.run(`
        CREATE TABLE message_attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          conversation_id TEXT,
          segment_id TEXT,
          type TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          width INTEGER NOT NULL DEFAULT 0,
          height INTEGER NOT NULL DEFAULT 0,
          detail TEXT NOT NULL DEFAULT 'auto',
          sha256 TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments(message_id)`)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON message_attachments(conversation_id)`)
      changed = true
    }

    // 迁移：message_attachments 表 source 列（user_upload | ai_generated）。
    // 旧附件全部视为用户上传。
    if (this.tableExists('message_attachments')) {
      const attCols = this.db.exec("PRAGMA table_info(message_attachments)")
      const attNames = attCols.length > 0 && attCols[0].values ? attCols[0].values.map((row) => String(row[1])) : []
      if (!attNames.includes('source')) {
        this.db.run("ALTER TABLE message_attachments ADD COLUMN source TEXT NOT NULL DEFAULT 'user_upload'")
        changed = true
      }
      // 迁移：message_attachments 表 usage 列（chat_input | generation_input | generation_output）。
      // 旧数据无法可靠区分「Chat 图片输入」与「图片生成参考图」，统一按 source 推导：
      //   ai_generated → generation_output
      //   user_upload  → chat_input（旧库尚无 generation_input 语义）
      // 新增列先置空，随后按 source 回填（幂等）。
      if (!attNames.includes('usage')) {
        this.db.run("ALTER TABLE message_attachments ADD COLUMN usage TEXT")
        this.db.run(`
          UPDATE message_attachments
          SET usage = CASE WHEN source = 'ai_generated' THEN 'generation_output' ELSE 'chat_input' END
          WHERE usage IS NULL
        `)
        changed = true
      }
    }

    // 迁移：image_generations 表（图片生成记录）。旧库无此表 → 自动创建。
    if (!this.tableExists('image_generations')) {
      this.db.run(`
        CREATE TABLE image_generations (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          prompt_message_id TEXT,
          result_message_id TEXT,
          provider_config_id TEXT,
          model_id TEXT,
          prompt TEXT NOT NULL,
          size TEXT,
          quality TEXT,
          background TEXT,
          output_format TEXT,
          n INTEGER NOT NULL DEFAULT 1,
          operation TEXT NOT NULL DEFAULT 'text_to_image',
          input_image_count INTEGER NOT NULL DEFAULT 0,
          revised_prompt TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `)
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_image_generations_conversation ON image_generations(conversation_id)`)
      changed = true
    } else {
      // 迁移：image_generations 增加 operation / input_image_count（图生图记录）。
      // 旧行一律回填 text_to_image / 0，历史文生图语义不变。
      const genCols = this.db.exec("PRAGMA table_info(image_generations)")
      const genNames = genCols.length > 0 && genCols[0].values ? genCols[0].values.map((row) => String(row[1])) : []
      if (!genNames.includes('operation')) {
        this.db.run("ALTER TABLE image_generations ADD COLUMN operation TEXT NOT NULL DEFAULT 'text_to_image'")
        changed = true
      }
      if (!genNames.includes('input_image_count')) {
        this.db.run("ALTER TABLE image_generations ADD COLUMN input_image_count INTEGER NOT NULL DEFAULT 0")
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
        type TEXT NOT NULL DEFAULT 'chat',
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
        default_image_size TEXT,
        default_image_quality TEXT,
        default_image_background TEXT,
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
        reasoning_text TEXT,
        reasoning_display_mode TEXT NOT NULL DEFAULT 'none',
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
        image_generations_path TEXT,
        image_generation_profile_json TEXT,
        extra_headers TEXT,
        tool_calling TEXT NOT NULL DEFAULT 'auto',
        image_input INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        conversation_id TEXT,
        segment_id TEXT,
        type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT 'auto',
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user_upload',
        usage TEXT NOT NULL DEFAULT 'chat_input',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_attachments_message
        ON message_attachments(message_id);
      CREATE INDEX idx_attachments_conversation
        ON message_attachments(conversation_id);

      CREATE TABLE image_generations (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        prompt_message_id TEXT,
        result_message_id TEXT,
        provider_config_id TEXT,
        model_id TEXT,
        prompt TEXT NOT NULL,
        size TEXT,
        quality TEXT,
        background TEXT,
        output_format TEXT,
        n INTEGER NOT NULL DEFAULT 1,
        operation TEXT NOT NULL DEFAULT 'text_to_image',
        input_image_count INTEGER NOT NULL DEFAULT 0,
        revised_prompt TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE INDEX idx_image_generations_conversation
        ON image_generations(conversation_id);
    `)
  }
}