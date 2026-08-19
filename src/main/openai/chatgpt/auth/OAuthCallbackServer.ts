import * as http from 'http'

export interface CallbackResult {
  code: string
  state: string
}

export class CallbackTimeoutError extends Error {
  constructor() {
    super('OAuth callback timeout')
    this.name = 'CallbackTimeoutError'
  }
}

export class StateMismatchError extends Error {
  constructor() {
    super('OAuth state mismatch')
    this.name = 'StateMismatchError'
  }
}

export class CallbackAlreadyInProgressError extends Error {
  constructor() {
    super('Another OAuth callback flow is already in progress')
    this.name = 'CallbackAlreadyInProgressError'
  }
}

const DEFAULT_PORT = 1455
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * 本地 HTTP 服务器，监听 127.0.0.1:1455
 * 处理 OAuth 回调 GET /auth/callback?code=...&state=...
 */
export class OAuthCallbackServer {
  private server: http.Server | null = null
  private port: number
  private pending: boolean = false

  constructor(port: number = DEFAULT_PORT) {
    this.port = port
  }

  /**
   * 启动回调服务器，等待浏览器回调
   * @param expectedState 期望的 state 值
   * @param timeoutMs 超时时间（毫秒）
   */
  start(expectedState: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CallbackResult> {
    if (this.pending) {
      return Promise.reject(new CallbackAlreadyInProgressError())
    }
    this.pending = true

    return new Promise<CallbackResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stop()
        reject(new CallbackTimeoutError())
      }, timeoutMs)

      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)

        if (url.pathname === '/auth/callback') {
          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state')

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(htmlPage('登录失败', '未收到授权码。'))
            return
          }

          if (state !== expectedState) {
            clearTimeout(timeout)
            this.stop()
            reject(new StateMismatchError())
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(htmlPage('登录失败', 'State 验证失败，请重试。'))
            return
          }

          clearTimeout(timeout)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(htmlPage('登录成功', '授权已完成，您可以关闭此页面。'))

          // 异步关闭，让 response 先发送
          setImmediate(() => this.stop())
          resolve({ code, state })
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout)
        this.pending = false
        reject(err)
      })

      this.server.listen(this.port, '127.0.0.1')
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.pending = false
  }
}

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:60px;">
  <h2>${title}</h2>
  <p>${message}</p>
</body>
</html>`
}