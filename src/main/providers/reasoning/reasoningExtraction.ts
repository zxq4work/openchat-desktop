/**
 * structured reasoning extraction helper。
 *
 * 只识别当前已被真实响应证据确认的 OpenAI-compatible reasoning transport：
 *   - reasoning         （vLLM 现任 canonical 字段，2024+ 由 reasoning_content 迁移而来）
 *   - reasoning_content （Qwen / DeepSeek / GLM 等 OpenAI-compatible 广泛使用）
 *
 * 明确不匹配：
 *   - 未知 reasoning-like key（chain_of_thought / cot / scratchpad ...）
 *   - 前缀 / 子串猜测（key.startsWith('reason') / key.includes('think')）
 *   - reasoning_details（数组 / opaque item，单独审计，见 ChatCompletionReasoningNormalizer）
 *
 * 同一 raw payload 同时出现两个字段时只取一个（优先级：reasoning > reasoning_content），
 * 绝不 append 两次。
 */

export type StructuredReasoningField = 'reasoning' | 'reasoning_content'

export interface StructuredReasoningResult {
  // 被选中的 reasoning 文本；两个字段都缺失或都不是非空字符串时为 null
  text: string | null
  // 被选中的字段名；未命中时为 null
  source: StructuredReasoningField | null
  // 两个字段都出现且值不同 → true（供 debug 记录，production 仍按优先级取一个）
  multipleStructuredReasoningFields: boolean
}

// 结构化 reasoning 字段优先级：vLLM 现任 canonical 字段优先。
// 若两个字段同时出现，只取优先级最高者，绝不拼接。
const REASONING_FIELD_PRIORITY: StructuredReasoningField[] = ['reasoning', 'reasoning_content']

export function extractStructuredReasoning(payload: Record<string, unknown> | null | undefined): StructuredReasoningResult {
  if (!payload || typeof payload !== 'object') {
    return { text: null, source: null, multipleStructuredReasoningFields: false }
  }

  const values: Partial<Record<StructuredReasoningField, unknown>> = {}
  for (const field of REASONING_FIELD_PRIORITY) {
    if (field in payload) values[field] = payload[field]
  }

  // 只接受非空字符串；空字符串 / null / 非字符串都不算命中
  const present = REASONING_FIELD_PRIORITY.filter((field) => typeof values[field] === 'string' && (values[field] as string).length > 0)
  if (present.length === 0) {
    return { text: null, source: null, multipleStructuredReasoningFields: false }
  }

  const source = present[0]
  const text = values[source] as string
  const multipleStructuredReasoningFields = present.length > 1 && values[present[0]] !== values[present[1]]

  return { text, source, multipleStructuredReasoningFields }
}

// 当前被明确支持的 structured reasoning 字段名集合（用于「已知字段」判断，
// 避免被 reasoning-like key 检测误报为 unknown）。
export const KNOWN_STRUCTURED_REASONING_FIELDS: ReadonlySet<string> = new Set(['reasoning', 'reasoning_content'])

// 已知但本轮不解析的字段（仅 debug 记录，绝不进入 visible reasoning）。
export const KNOWN_UNPARSED_REASONING_FIELDS: ReadonlySet<string> = new Set(['reasoning_details'])

// 覆盖真实出现过的「reasoning-like 但非本轮支持」字段名（chain_of_thought / think_text /
// thought_text / analysis_text / scratchpad / cot 等）。仅用于 debug 提示，绝不解析其值。
const REASONING_LIKE_RE = /reason|think|thought|analysis|scratchpad|(?:^|_)cot(?:_|$)/i

/**
 * 在 raw delta / message keys 中寻找「reasoning-like 但未知」的字段名。
 * 仅返回 key 名用于 debug，绝不读取 / 解析其值。
 */
export function findUnknownReasoningLikeField(keys: string[]): string | null {
  for (const key of keys) {
    if (KNOWN_STRUCTURED_REASONING_FIELDS.has(key)) continue
    if (KNOWN_UNPARSED_REASONING_FIELDS.has(key)) continue
    if (REASONING_LIKE_RE.test(key)) return key
  }
  return null
}
