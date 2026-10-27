// Anthropic Messages 非流式响应 → CanonicalModelEvent（一次性）。
// 与流式解析共用相同的 native_block / usage / stop_reason 语义。

import type {
  CanonicalModelEvent,
  CanonicalNativeBlock,
  CanonicalTokenUsage,
} from '../../../shared/types/provider'

interface AnthropicMessageResponse {
  id?: string
  type?: string
  role?: string
  model?: string
  content?: unknown[]
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: unknown
}

function normalizeUsage(raw: unknown): CanonicalTokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const out: CanonicalTokenUsage = { raw: u }
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens
  if (typeof u.cache_creation_input_tokens === 'number') out.cacheCreationInputTokens = u.cache_creation_input_tokens
  if (typeof u.cache_read_input_tokens === 'number') out.cacheReadInputTokens = u.cache_read_input_tokens
  return out
}

// 把非流式响应转换为 canonical 事件序列。
export function normalizeAnthropicResponse(response: unknown): CanonicalModelEvent[] {
  const out: CanonicalModelEvent[] = []
  const msg = (response ?? {}) as AnthropicMessageResponse
  const content = Array.isArray(msg.content) ? msg.content : []

  let reasoningOpen = false
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== 'object') continue
    const block = rawBlock as Record<string, unknown>
    const blockType = typeof block.type === 'string' ? block.type : 'unknown'
    const native: CanonicalNativeBlock = { ...block, type: blockType }

    if (blockType === 'text') {
      if (reasoningOpen) {
        reasoningOpen = false
        out.push({ type: 'reasoning_completed' })
      }
      const text = typeof block.text === 'string' ? block.text : ''
      if (text) out.push({ type: 'delta', text })
      out.push({ type: 'native_block', block: native })
      continue
    }

    if (blockType === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : ''
      if (!reasoningOpen) {
        reasoningOpen = true
        out.push({ type: 'reasoning_started' })
      }
      if (thinking) out.push({ type: 'reasoning_delta', text: thinking })
      out.push({ type: 'native_block', block: native })
      continue
    }

    if (blockType === 'redacted_thinking') {
      // 不进入正文，但保留原始块（含 data）
      out.push({ type: 'native_block', block: native })
      continue
    }

    if (blockType === 'tool_use') {
      if (reasoningOpen) {
        reasoningOpen = false
        out.push({ type: 'reasoning_completed' })
      }
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      const input = block.input && typeof block.input === 'object' ? block.input : {}
      if (id && name) {
        out.push({ type: 'tool_call', callId: id, name, arguments: JSON.stringify(input) })
      }
      out.push({ type: 'native_block', block: native })
      continue
    }

    // 未知内容块：保留原始对象，绝不强转为文本
    out.push({ type: 'native_block', block: native })
  }

  if (reasoningOpen) {
    out.push({ type: 'reasoning_completed' })
  }

  if (typeof msg.stop_reason === 'string') {
    out.push({ type: 'stop_reason', reason: msg.stop_reason })
  }
  const usage = normalizeUsage(msg.usage)
  if (usage) out.push({ type: 'usage', usage })

  return out
}