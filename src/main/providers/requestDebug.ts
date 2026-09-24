import type { ResolvedRequestParameter } from '../../shared/types/provider'

// 「实际最终发送参数」开发日志：让用户在不抓包的前提下确认最终 request body 的字段形状与取值。
// 安全约束（必须严格遵守）：
// - 绝不整段打印 body（可能含 messages / prompt / 图片 Base64 / 大上下文 / tools）；
// - prompt 只打印长度；messages / tools / input 只打印数量；
// - 图片 Data URI（data:...）→ '<data-url omitted>'；图片数组 → '<image array count=N>'；
// - 键名命中 authorization | api[-_]?key | token | secret | password | cookie → '<redacted>'；
// - 长字符串（>128）→ '<string length=N>'。
// 日志前缀统一为 [RequestDebug]，便于 grep。

const SECRET_KEY_PATTERN = /authorization|api[-_]?key|token|secret|password|cookie/i
const MAX_STRING_LEN = 128

// 只有当显式开启时才输出：OPENCHAT_DEBUG_REQUEST_PARAMS=1 或 =true。
export function isRequestParamDebugEnabled(): boolean {
  const v = process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
  return v === '1' || v === 'true'
}

// 顶层键名的语义化摘要：数量类字段只打印数量，避免把大内容写进日志。
function summarizeKnownCountKey(key: string, val: unknown): string | null {
  switch (key) {
    case 'prompt':
      return `promptLength=${typeof val === 'string' ? val.length : 0}`
    case 'messages':
      return Array.isArray(val) ? `messagesCount=${val.length}` : null
    case 'tools':
      return Array.isArray(val) ? `toolsCount=${val.length}` : null
    case 'input':
      if (Array.isArray(val)) return `inputCount=${val.length}`
      if (typeof val === 'string') return `inputLength=${val.length}`
      return null
    case 'instructions':
      return typeof val === 'string' ? `instructionsLength=${val.length}` : null
    default:
      return null
  }
}

// 通用值 sanitize：不感知键名，只保证不泄漏字节/长文本/Data URI。
export function sanitizeScalarValue(value: unknown): unknown {
  if (value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '<data-url omitted>'
    if (value.length <= MAX_STRING_LEN) return value
    return `<string length=${value.length}>`
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === 'string' && v.startsWith('data:'))) {
      return `<image array count=${value.length}>`
    }
    return `<array count=${value.length}>`
  }
  if (typeof value === 'object') return `<object keys=${Object.keys(value as object).length}>`
  return typeof value
}

// 单字段摘要：先处理语义化数量键，再处理敏感键，最后走通用 sanitize。
function summarizeField(key: string, val: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '<redacted>'
  const counted = summarizeKnownCountKey(key, val)
  if (counted !== null) return counted
  if (key === 'extra_body' && val && typeof val === 'object' && !Array.isArray(val)) {
    const eb: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const nested = summarizeKnownCountKey(k, v)
      eb[k] = SECRET_KEY_PATTERN.test(k) ? '<redacted>' : nested !== null ? nested : sanitizeScalarValue(v)
    }
    return eb
  }
  return sanitizeScalarValue(val)
}

// 生成 body 的安全镜像：保留注入字段的位置与标量取值，抹去大内容与敏感信息。
export function summarizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(body)) {
    out[key] = summarizeField(key, val)
  }
  return out
}

// 请求发送前调用：打印最终 shape + 已注入的动态参数。
// resolved 为 Main 权威层解析出的 (id, path, value) 列表，用于回答「到底发了哪个参数、什么值」。
export function logFinalRequestDebug(
  protocol: string,
  body: Record<string, unknown>,
  resolved?: ResolvedRequestParameter[],
  endpoint?: string
): void {
  if (!isRequestParamDebugEnabled()) return
  const topLevelKeys = Object.keys(body)
  const extra = body.extra_body
  const extraBodyKeys =
    extra && typeof extra === 'object' && !Array.isArray(extra)
      ? Object.keys(extra as Record<string, unknown>)
      : []
  const appliedDynamicParameters = (resolved ?? []).map((r) => ({
    id: r.id,
    path: r.path,
    value: sanitizeScalarValue(r.value),
  }))

  console.log('[RequestDebug] protocol=%s endpoint=%s', protocol, endpoint ?? '-')
  console.log('[RequestDebug] topLevelKeys=%s', JSON.stringify(topLevelKeys))
  console.log('[RequestDebug] extraBodyKeys=%s', JSON.stringify(extraBodyKeys))
  console.log('[RequestDebug] appliedDynamicParameters=%s', JSON.stringify(appliedDynamicParameters))
  console.log('[RequestDebug] finalRequestShape=%s', JSON.stringify(summarizeRequestBody(body)))
}

// 参数错误日志：只打印 id + 原因，绝不打印完整 body。
export function logRequestParameterError(reason: string, id = '-'): void {
  console.error('[RequestParameterError] id=%s reason=%s', id, reason)
}
