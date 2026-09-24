/**
 * ReasoningDebug — OpenAI-compatible reasoning 响应形状诊断。
 *
 * 目的：Provider 返回了 reasoning 但未进入 UI 时，不抓包也能判断真实 response shape。
 * 打印位置必须在真正解析 HTTP response 的 Main/Adapter 侧。
 *
 * 隐私约束（硬性）：
 *   只打印 protocol / delta keys / reasoning 字段名 / 长度 / parser phase / canonical events。
 *   绝不打印 reasoning 正文、content 正文、prompt、messages。
 *
 * 开关：OPENCHAT_DEBUG_REASONING=1（或 'true'）。启动时打印一次 enabled=true。
 */

let enabled = false

export function initReasoningDebug(): void {
  const raw = process.env.OPENCHAT_DEBUG_REASONING
  enabled = raw === '1' || raw === 'true'
  if (enabled) {
    console.log('[ReasoningDebug] enabled=true')
  }
}

export interface ReasoningDebugPayload {
  protocol: string
  choiceIndex?: number
  deltaKeys?: string[]
  messageKeys?: string[]
  reasoningField?: string | null
  reasoningLength?: number
  contentLength?: number
  phase?: string
  events?: string[]
  finishReason?: string | null
  unknownReasoningLikeField?: string
  multipleStructuredReasoningFields?: boolean
  finalThenReasoningAnomaly?: boolean
  reasoningDetailsPresent?: boolean
  reasoningDetailsItemTypes?: string[]
  // Debug-only 提示：content 起始疑似上游 <think> 泄漏（OpenChat 不解析，原样作为正文）。
  possibleInlineThinkLeak?: boolean
  note?: string
}

// 协议级连续重复日志抑制：按 protocol 记录上一条 fingerprint，
// 仅在 shape / state 变化时打印，抑制连续相同 shape 的日志。
const lastFingerprint = new Map<string, string>()

export function reasoningDebug(payload: ReasoningDebugPayload): void {
  if (!enabled) return

  // fingerprint 只含结构性字段（不含文本），用于抑制重复行
  const fingerprint = [
    payload.protocol,
    payload.choiceIndex,
    (payload.deltaKeys ?? []).join(','),
    (payload.messageKeys ?? []).join(','),
    payload.reasoningField ?? '',
    payload.phase ?? '',
    (payload.events ?? []).join(','),
    payload.finishReason ?? '',
    payload.possibleInlineThinkLeak === undefined ? '' : String(payload.possibleInlineThinkLeak),
  ].join('|')

  if (fingerprint && lastFingerprint.get(payload.protocol) === fingerprint) return
  lastFingerprint.set(payload.protocol, fingerprint)

  // 只输出已定义的字段（对象字面量，避免字符串拼接注入）
  const line: Record<string, unknown> = { protocol: payload.protocol }
  if (payload.choiceIndex !== undefined) line.choiceIndex = payload.choiceIndex
  if (payload.deltaKeys) line.deltaKeys = payload.deltaKeys
  if (payload.messageKeys) line.messageKeys = payload.messageKeys
  if (payload.reasoningField !== undefined) line.reasoningField = payload.reasoningField
  if (payload.reasoningLength !== undefined) line.reasoningLength = payload.reasoningLength
  if (payload.contentLength !== undefined) line.contentLength = payload.contentLength
  if (payload.phase !== undefined) line.phase = payload.phase
  if (payload.events) line.events = payload.events
  if (payload.finishReason !== undefined) line.finishReason = payload.finishReason
  if (payload.unknownReasoningLikeField !== undefined) line.unknownReasoningLikeField = payload.unknownReasoningLikeField
  if (payload.multipleStructuredReasoningFields !== undefined) line.multipleStructuredReasoningFields = payload.multipleStructuredReasoningFields
  if (payload.finalThenReasoningAnomaly !== undefined) line.finalThenReasoningAnomaly = payload.finalThenReasoningAnomaly
  if (payload.reasoningDetailsPresent !== undefined) line.reasoningDetailsPresent = payload.reasoningDetailsPresent
  if (payload.reasoningDetailsItemTypes) line.reasoningDetailsItemTypes = payload.reasoningDetailsItemTypes
  if (payload.possibleInlineThinkLeak !== undefined) line.possibleInlineThinkLeak = payload.possibleInlineThinkLeak
  if (payload.note !== undefined) line.note = payload.note

  console.log('[ReasoningDebug]', JSON.stringify(line))
}
