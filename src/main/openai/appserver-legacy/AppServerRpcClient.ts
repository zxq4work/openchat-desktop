import { AppServerProcess } from './AppServerProcess'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  id: number
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 30000

/**
 * 负责 JSONL 编解码、自增 request id、pending request Map、
 * timeout、notification dispatch、process crash 时 reject 所有 pending
 *
 * @deprecated App Server 已不作为默认 Provider。
 */
export class AppServerRpcClient {
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>()
  private process: AppServerProcess
  private buffer = ''

  constructor(process: AppServerProcess) {
    this.process = process
    this.process.on('stdout', (line: string) => this.handleLine(line))
    this.process.on('exit', () => this.handleProcessExit())
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      id,
      params,
    }

    const stdin = this.process.stdin
    if (!stdin) {
      return Promise.reject(new Error('App Server process is not running'))
    }

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer } as PendingRequest)
    })

    stdin.write(JSON.stringify(request) + '\n')

    return promise
  }

  notify(method: string, params?: unknown): void {
    const stdin = this.process.stdin
    if (!stdin) {
      return
    }
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    }
    stdin.write(JSON.stringify(notification) + '\n')
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method) ?? []
    handlers.push(handler)
    this.notificationHandlers.set(method, handlers)
  }

  offNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method)
    if (!handlers) return
    const idx = handlers.indexOf(handler)
    if (idx >= 0) handlers.splice(idx, 1)
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line)
      if ('id' in msg && 'method' in msg) {
        // Server request — 第一阶段不处理
        return
      }
      if ('id' in msg && !('method' in msg)) {
        this.handleResponse(msg as JsonRpcResponse)
      }
      if ('method' in msg && !('id' in msg)) {
        this.handleNotification(msg as JsonRpcNotification)
      }
    } catch {
      // JSON parse error — 记录日志但不崩溃
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(response.id)

    if (response.error) {
      pending.reject(new Error(`RPC error: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const handlers = this.notificationHandlers.get(notification.method)
    if (!handlers) return
    for (const handler of handlers) {
      handler(notification.params)
    }
  }

  private handleProcessExit(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('App Server process exited'))
    }
    this.pending.clear()
  }
}