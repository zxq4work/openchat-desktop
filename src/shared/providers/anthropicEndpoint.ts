// Anthropic Messages API 的地址解析（纯函数，Main 与 Renderer 共用，便于单测）。
//
// 规则（基于 URL pathname，绝不对完整 URL 字符串做盲目替换，避免破坏查询参数 /
// 反向代理路径前缀 / 主机名 / 端口 / 协议）：
//   https://host.example            → https://host.example/v1/messages
//   https://host.example/           → https://host.example/v1/messages
//   https://host.example/v1         → https://host.example/v1/messages
//   https://host.example/v1/        → https://host.example/v1/messages
//   https://host.example/v1/messages → 原地址不变
//   https://host.example/anthropic  → https://host.example/anthropic/v1/messages
//
// 若用户填写了完整 Endpoint 覆盖，则原样使用（不重写、不追加路径）。

export const ANTHROPIC_DEFAULT_VERSION = '2023-06-01'
export const ANTHROPIC_KNOWN_VERSION_2026 = '2026-10-21'
export const ANTHROPIC_MESSAGES_SEGMENT = '/messages'

// 从 baseUrl 推导默认的 /v1/messages 地址。baseUrl 非法时返回 null（调用方须显式报错）。
export function resolveAnthropicMessagesUrl(baseUrl: string, endpointOverride?: string | null): string | null {
  const override = (endpointOverride ?? '').trim()
  if (override) {
    try {
      const u = new URL(override)
      // 完整 Endpoint 覆盖：原样返回（保持用户填写的路径与查询参数）。
      return u.toString()
    } catch {
      return null
    }
  }

  let parsed: URL
  try {
    parsed = new URL((baseUrl ?? '').trim())
  } catch {
    return null
  }

  // 去掉尾部斜杠后的 pathname；保留反向代理前缀（如 /anthropic）。
  let path = parsed.pathname.replace(/\/+$/, '')
  if (path.endsWith(ANTHROPIC_MESSAGES_SEGMENT)) {
    // 已完整指向 /messages（例如 /v1/messages、/anthropic/v1/messages）
    parsed.pathname = path
  } else if (path === '' || path === '/') {
    parsed.pathname = '/v1/messages'
  } else if (path.endsWith('/v1')) {
    parsed.pathname = `${path}/messages`
  } else {
    parsed.pathname = `${path}/v1/messages`
  }
  // 防御：任何情况下都不允许出现 /v1/v1 或 /messages/messages。
  parsed.pathname = parsed.pathname.replace(/\/v1\/v1\//g, '/v1/').replace(/\/messages\/messages$/g, '/messages')
  return parsed.toString()
}

// 显式自定义路径：与 Chat Completions / Responses 的既有约定一致，
// 路径由用户明确填写，直接拼接到 baseUrl 之后（不做默认推导）。
export function joinAnthropicCustomPath(baseUrl: string, customPath: string): string | null {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '')
  const p = (customPath ?? '').trim()
  if (!base || !p) return null
  try {
    // 校验最终地址可解析
    return new URL(`${base}${p.startsWith('/') ? p : `/${p}`}`).toString()
  } catch {
    return null
  }
}

// 版本感知：2026-10-21 及以后不允许发送 temperature / top_p / top_k。
// 未知版本采取保守策略：不因版本字符串猜测能力，但仍按已知版本号判定。
export function isSamplingParamsRemoved(apiVersion: string | undefined | null): boolean {
  const v = (apiVersion ?? '').trim()
  if (!v) return false
  return v === ANTHROPIC_KNOWN_VERSION_2026
}

// ── Anthropic reasoning effort（顶层 output_config.effort）──
// Anthropic 原生合法值：low / medium / high / xhigh / max。
// 仅做协议字段映射：UI 选项来自通用 ReasoningSelector，不在此定义选项集合。
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// 把会话中保存的 effort 值映射为可发送的 Anthropic effort；不可发送返回 null。
// OpenChat 通用等级（none/minimal/low/medium/high/xhigh/max）→ Anthropic 原生等级：
//   none    → null（不发送 Effort）
//   minimal → low（Anthropic 无比 low 更低的档位，做兼容映射）
//   low     → low
//   medium  → medium
//   high    → high
//   xhigh   → xhigh
//   max     → max
// 绝不发送 minimal / none / auto 等非法值。
export function toAnthropicEffort(effort: string | null | undefined): AnthropicEffort | null {
  switch ((effort ?? '').trim().toLowerCase()) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    default:
      return null
  }
}
