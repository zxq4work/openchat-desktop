// Anthropic HTTP / 流内错误映射。
// 必须容错：第三方网关可能返回非标准 JSON 或纯文本错误页。

export interface AnthropicMappedError {
  code: string
  message: string
  status: number | null
  requestId: string | null
  retryAfter: string | null
  retryable: boolean
}

// 从 HTTP 错误响应体 + 状态码映射为标准错误。
export function mapAnthropicHttpError(
  status: number | null,
  bodyText: string,
  headers?: Record<string, string | string[] | undefined>
): AnthropicMappedError {
  let errorType = ''
  let message = ''
  let requestId: string | null = null

  if (bodyText && bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const err = parsed.error as Record<string, unknown> | undefined
        if (err && typeof err === 'object') {
          if (typeof err.type === 'string') errorType = err.type
          if (typeof err.message === 'string') message = err.message
        }
        if (typeof parsed.request_id === 'string') requestId = parsed.request_id
        // 某些网关把 message 放在顶层
        if (!message && typeof parsed.message === 'string') message = parsed.message
      }
    } catch {
      // 非 JSON：使用截断的纯文本
      message = bodyText.slice(0, 500)
    }
  }

  const retryAfter = readRetryAfter(headers)
  const mapped = classify(status, errorType, message)
  return {
    code: mapped.code,
    message: message || mapped.fallbackMessage,
    status,
    requestId,
    retryAfter,
    retryable: mapped.retryable,
  }
}

function readRetryAfter(headers?: Record<string, string | string[] | undefined>): string | null {
  if (!headers) return null
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'retry-after') {
      const v = headers[key]
      if (Array.isArray(v)) return v[0] ?? null
      return v ?? null
    }
  }
  return null
}

function classify(status: number | null, errorType: string, message: string): { code: string; fallbackMessage: string; retryable: boolean } {
  const t = errorType.toLowerCase()
  const isAuth = status === 401 || t === 'authentication_error'
  const isPermission = status === 403 || t === 'permission_error'
  const isRate = status === 429 || t === 'rate_limit_error'
  const isOverloaded = status === 529 || t === 'overloaded_error'
  const isRequest = status === 400 || t === 'invalid_request_error'
  const isNotFound = status === 404 || t === 'not_found_error'
  const isTooLarge = status === 413 || t === 'request_too_large'
  const isTimeout = status === 408 || t === 'timeout_error'
  const isServer = status != null && status >= 500 && !isOverloaded

  let code = 'ANTHROPIC_HTTP_ERROR'
  let fallbackMessage = message || 'Anthropic 请求失败'
  if (isAuth) { code = 'ANTHROPIC_AUTH_ERROR'; fallbackMessage = '鉴权失败，请检查 API Key' }
  else if (isPermission) { code = 'ANTHROPIC_PERMISSION_ERROR'; fallbackMessage = '无权限访问该模型或资源' }
  else if (isRate) { code = 'ANTHROPIC_RATE_LIMITED'; fallbackMessage = '请求过于频繁，请稍后重试' }
  else if (isOverloaded) { code = 'ANTHROPIC_OVERLOADED'; fallbackMessage = '服务过载，请稍后重试' }
  else if (isNotFound) { code = 'ANTHROPIC_NOT_FOUND'; fallbackMessage = '端点或模型不存在' }
  else if (isTooLarge) { code = 'ANTHROPIC_REQUEST_TOO_LARGE'; fallbackMessage = '请求体过大' }
  else if (isTimeout) { code = 'ANTHROPIC_TIMEOUT'; fallbackMessage = '请求超时' }
  else if (isServer) { code = 'ANTHROPIC_SERVER_ERROR'; fallbackMessage = '服务端异常' }
  else if (isRequest) { code = 'ANTHROPIC_INVALID_REQUEST'; fallbackMessage = '请求参数错误' }

  // 可重试：网络错误（无 status）、429、529、5xx、超时
  const retryable = status == null || isRate || isOverloaded || isTimeout || isServer
  if (status == null) { code = 'ANTHROPIC_NETWORK_ERROR'; fallbackMessage = message || '网络连接失败' }

  return { code, fallbackMessage, retryable }
}

// 把映射错误格式化为抛给上层的 Error（message 含 error.type 便于 isToolsUnsupportedError 等既有判定）。
export class AnthropicApiError extends Error {
  code: string
  status: number | null
  requestId: string | null
  retryAfter: string | null
  retryable: boolean
  constructor(mapped: AnthropicMappedError) {
    super(`HTTP ${mapped.status ?? 'ERR'} ${mapped.code}: ${mapped.message}`)
    this.name = 'AnthropicApiError'
    this.code = mapped.code
    this.status = mapped.status
    this.requestId = mapped.requestId
    this.retryAfter = mapped.retryAfter
    this.retryable = mapped.retryable
  }
}