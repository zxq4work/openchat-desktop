import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

export type AppServerMode = 'mock' | 'bundled'

export interface AppServerProcessEvents {
  stdout: (line: string) => void
  stderr: (line: string) => void
  exit: (code: number | null, signal: string | null) => void
}

/**
 * 只负责 App Server 进程生命周期管理
 * start / stop / restart / health
 * 不包含任何业务逻辑
 *
 * mock 模式：启动 scripts/mock-app-server.mjs
 * bundled 模式：启动真实 Codex CLI 二进制
 *
 * @deprecated App Server 已不作为默认 Provider，保留用于兼容。
 */
export class AppServerProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private binaryPath: string
  private codexHome: string
  private configPath: string
  private mode: AppServerMode

  constructor(binaryPath: string, codexHome: string, configPath: string, mode: AppServerMode = 'mock') {
    super()
    this.binaryPath = binaryPath
    this.codexHome = codexHome
    this.configPath = configPath
    this.mode = mode
  }

  start(): void {
    if (this.proc) {
      return
    }

    if (this.mode === 'mock') {
      this.startMock()
    } else {
      this.startBundled()
    }
  }

  private startMock(): void {
    const mockScript = this.resolveMockScript()

    this.proc = spawn('node', [mockScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.setupStreams()
    this.setupLifecycle()
  }

  private startBundled(): void {
    this.ensureCodexHome()

    const env = {
      ...process.env,
      CODEX_HOME: this.codexHome,
    }

    this.proc = spawn(this.binaryPath, ['app-server'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.setupStreams()
    this.setupLifecycle()
  }

  private resolveMockScript(): string {
    // 从 dist 目录向上找到项目根目录
    const candidates = [
      path.join(__dirname, '../../../../scripts/mock-app-server.mjs'),
      path.join(__dirname, '../../../scripts/mock-app-server.mjs'),
      path.join(__dirname, '../../scripts/mock-app-server.mjs'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return path.resolve(candidate)
      }
    }
    // 最终回退
    return path.resolve(__dirname, '../../../../scripts/mock-app-server.mjs')
  }

  private setupStreams(): void {
    if (!this.proc) return

    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')

    let stdoutBuffer = ''
    this.proc.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) {
          this.emit('stdout', line)
        }
      }
    })

    let stderrBuffer = ''
    this.proc.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) {
          this.emit('stderr', line)
        }
      }
    })
  }

  private setupLifecycle(): void {
    if (!this.proc) return

    this.proc.on('exit', (code, signal) => {
      this.proc = null
      this.emit('exit', code, signal)
    })

    this.proc.on('error', (err) => {
      this.emit('stderr', `[process error] ${err.message}`)
    })
  }

  stop(): void {
    if (!this.proc) {
      return
    }
    const proc = this.proc
    this.proc = null
    try {
      proc.kill('SIGTERM')
    } catch {
      // 忽略进程已退出
    }
  }

  restart(): void {
    this.stop()
    this.start()
  }

  get isRunning(): boolean {
    return this.proc !== null
  }

  get stdin(): NodeJS.WritableStream | null {
    return this.proc ? this.proc.stdin : null
  }

  private ensureCodexHome(): void {
    if (!fs.existsSync(this.codexHome)) {
      fs.mkdirSync(this.codexHome, { recursive: true })
    }
    if (this.configPath && !fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, this.defaultConfig(), 'utf8')
    }
  }

  private defaultConfig(): string {
    return `forced_login_method = "chatgpt"

check_for_update_on_startup = false

web_search = "disabled"

file_opener = "none"

approval_policy = "never"

[features]
apps = false
goals = false
hooks = false
memories = false
multi_agent = false
shell_tool = false
skill_mcp_dependency_install = false
unified_exec = false

[tools]
view_image = false
web_search = false
`
  }
}
