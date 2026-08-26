import type { IncomingHttpHeaders } from 'http'

// 固定需要打印的 rate-limit 相关 header（全部脱敏，不涉及 credential）
const FIXED_HEADERS = [
  'content-type',
  'retry-after',
  'x-codex-primary-used-percent',
  'x-codex-primary-window-minutes',
  'x-codex-primary-reset-at',
  'x-codex-secondary-used-percent',
  'x-codex-secondary-window-minutes',
  'x-codex-secondary-reset-at',
  'x-codex-rate-limit-reached-type',
  'x-oai-request-id',
  'x-request-id',
  'cf-ray',
]

// 枚举规则：x-codex- 前缀，或 x-*-primary-used-percent / x-*-secondary-used-percent
function isRateLimitHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('x-codex-')) return true
  if (/^x-.*-primary-used-percent$/.test(lower)) return true
  if (/^x-.*-secondary-used-percent$/.test(lower)) return true
  return false
}

// 脱敏：去除任何可能的 credential 字符串（Bearer token / access_token / refresh_token / id_token）
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"[REDACTED]"')
    .replace(/"refresh_token"\s*:\s*"[^"]*"/gi, '"refresh_token":"[REDACTED]"')
    .replace(/"id_token"\s*:\s*"[^"]*"/gi, '"id_token":"[REDACTED]"')
}

// 打印非 2xx 响应的脱敏 headers + body，返回描述性错误信息
export function logNon2xxResponse(
  endpoint: string,
  method: string,
  status: number,
  headers: IncomingHttpHeaders,
  body: string
): string {
  console.log('[429 Response Headers]')
  console.log(`endpoint=${method} ${endpoint}`)
  console.log(`status=${status}`)

  for (const name of FIXED_HEADERS) {
    const value = headers[name]
    if (value != null) {
      console.log(`${name}=${Array.isArray(value) ? value.join(', ') : value}`)
    }
  }

  // 枚举所有匹配 rate-limit 命名规范的 header
  const seen = new Set(FIXED_HEADERS)
  for (const [name, value] of Object.entries(headers)) {
    if (!seen.has(name.toLowerCase()) && isRateLimitHeader(name)) {
      console.log(`${name}=${Array.isArray(value) ? value.join(', ') : value}`)
    }
  }

  const truncatedBody = body.slice(0, 4000)
  console.log('[429 Response Body]')
  console.log(redactSecrets(truncatedBody))

  return `HTTP ${status} from ${method} ${endpoint}`
}
