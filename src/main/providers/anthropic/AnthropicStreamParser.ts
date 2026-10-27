// Anthropic Messages SSE 事件 → CanonicalModelEvent 的状态机。
//
// 关键约束：
// - 内容块必须按 index 单独管理，绝不用一个字符串同时拼接正文 / 思考 / 工具参数。
// - message_delta.usage.output_tokens 是累计值，绝不按增量累加。
// - 工具 input_json_delta 只能累积，待 content_block_stop 后再 JSON.parse。
// - 任何未知事件 / delta 类型都必须容错，且不破坏后续已知事件处理。
// - thinking / redacted_thinking / tool_use 块以 native_block 事件送给上层无损持久化。

import type {
  CanonicalModelEvent,
  CanonicalNativeBlock,
  CanonicalTokenUsage,
} from '../../../shared/types/provider'

interface BlockState {
  index: number
  type: string
  // 原始块（用于生成 native_block）。text / thinking / tool_use 等在 delta 中累积。
  block: CanonicalNativeBlock
  // tool_use 的 JSON 参数累积缓冲（仅来自 input_json_delta）。
  jsonBuffer: string
  // 非流式 tool_use 在 content_block_start 携带的初始 input（流式时为空的占位 {}，视为无）。
  startInput: Record<string, unknown> | null
  // thinking 已发出的 reasoning 文本（用于判断是否需要补发 completed）。
  reasoningEmitted: boolean
  // thinking 文本累积（用于 reasoning_completed 摘要兜底）。
  thinkingText: string
  // 是否已 finalize（防止 content_block_stop 与 message_stop 重复 emit）。
  finalized: boolean
}

export interface AnthropicStreamResult {
  messageId?: string
  model?: string
  stopReason?: string | null
  stopSequence?: string | null
  usage?: CanonicalTokenUsage
  blocks: CanonicalNativeBlock[]
  // 是否收到 message_stop（完整成功）。
  completed: boolean
  // 是否收到流内 error 事件。
  errored: boolean
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

export class AnthropicStreamParser {
  private blocks = new Map<number, BlockState>()
  private orderedIndices: number[] = []
  private activeReasoningIndex: number | null = null
  private messageId?: string
  private model?: string
  private stopReason: string | null = null
  private stopSequence: string | null = null
  private usage?: CanonicalTokenUsage
  private completed = false
  private errored = false

  // 处理单个已解码 SSE 事件，返回要向上层发出的 canonical 事件。
  handle(sseEvent: { event: string; data: string }): CanonicalModelEvent[] {
    const out: CanonicalModelEvent[] = []
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(sseEvent.data) as Record<string, unknown>
    } catch {
      // 非法 JSON：忽略但保持后续处理（绝不中断整条流）
      return out
    }

    // 事件类型优先取 data.type（Anthropic 两者一致），事件名作兜底。
    const type = typeof parsed.type === 'string' ? parsed.type : sseEvent.event

    switch (type) {
      case 'message_start': {
        const message = (parsed.message ?? {}) as Record<string, unknown>
        if (typeof message.id === 'string') this.messageId = message.id
        if (typeof message.model === 'string') this.model = message.model
        const usage = normalizeUsage(message.usage)
        if (usage) {
          this.usage = usage
          out.push({ type: 'usage', usage })
        }
        if (typeof message.stop_reason === 'string') this.stopReason = message.stop_reason
        break
      }

      case 'content_block_start': {
        const index = typeof parsed.index === 'number' ? parsed.index : this.orderedIndices.length
        const cb = (parsed.content_block ?? {}) as Record<string, unknown>
        const blockType = typeof cb.type === 'string' ? cb.type : 'unknown'
        const block: CanonicalNativeBlock = { ...cb, type: blockType }
        const state: BlockState = {
          index,
          type: blockType,
          block,
          jsonBuffer: '',
          // 流式 tool_use 的 start.input 通常是空 {} 占位；只有非空对象才当作非流式初始 input。
          startInput: cb.input && typeof cb.input === 'object' && !Array.isArray(cb.input) && Object.keys(cb.input).length > 0
            ? cb.input as Record<string, unknown>
            : null,
          reasoningEmitted: false,
          thinkingText: typeof cb.thinking === 'string' ? cb.thinking : '',
          finalized: false,
        }
        this.blocks.set(index, state)
        if (!this.orderedIndices.includes(index)) this.orderedIndices.push(index)

        if (blockType === 'thinking') {
          this.activeReasoningIndex = index
          out.push({ type: 'reasoning_started', itemId: String(index) })
        }
        // text_start 初始文本（通常为空）也要累积
        if (blockType === 'text' && typeof cb.text === 'string' && cb.text) {
          out.push({ type: 'delta', text: cb.text })
        }
        // tool_use 的非流式初始 input 已在 startInput 中记录，stop 时优先使用。
        // redacted_thinking 在 start 阶段就带完整 data → 直接作为 native_block 保留
        if (blockType === 'redacted_thinking') {
          // 不进入正文；native_block 由上层持久化
        }
        break
      }

      case 'content_block_delta': {
        const index = typeof parsed.index === 'number' ? parsed.index : -1
        const state = this.blocks.get(index)
        if (!state) break
        const delta = (parsed.delta ?? {}) as Record<string, unknown>
        const deltaType = typeof delta.type === 'string' ? delta.type : ''
        switch (deltaType) {
          case 'text_delta': {
            const text = typeof delta.text === 'string' ? delta.text : ''
            if (text) {
              state.block.text = (typeof state.block.text === 'string' ? state.block.text : '') + text
              out.push({ type: 'delta', text })
            }
            break
          }
          case 'thinking_delta': {
            const thinking = typeof delta.thinking === 'string' ? delta.thinking : ''
            if (thinking) {
              state.thinkingText += thinking
              // 累积到 block.thinking（不显示为正文，但需无损保存以便重放）。
              state.block.thinking = (typeof state.block.thinking === 'string' ? state.block.thinking : '') + thinking
              if (!state.reasoningEmitted) {
                state.reasoningEmitted = true
                this.activeReasoningIndex = index
              }
              out.push({ type: 'reasoning_delta', text: thinking })
            }
            break
          }
          case 'signature_delta': {
            const signature = typeof delta.signature === 'string' ? delta.signature : ''
            if (signature) {
              // 累积到 block，不显示为正文
              state.block.signature =
                (typeof state.block.signature === 'string' ? state.block.signature : '') + signature
            }
            break
          }
          case 'input_json_delta': {
            const partial = typeof delta.partial_json === 'string' ? delta.partial_json : ''
            if (partial) state.jsonBuffer += partial
            break
          }
          default:
            // 未知 delta 类型：容错，忽略
            break
        }
        break
      }

      case 'content_block_stop': {
        const index = typeof parsed.index === 'number' ? parsed.index : -1
        const state = this.blocks.get(index)
        if (state && !state.finalized) {
          out.push(...this.finalizeBlock(state))
        }
        if (this.activeReasoningIndex === index) {
          this.activeReasoningIndex = null
        }
        break
      }

      case 'message_delta': {
        const delta = (parsed.delta ?? {}) as Record<string, unknown>
        if (typeof delta.stop_reason === 'string') {
          this.stopReason = delta.stop_reason
          out.push({ type: 'stop_reason', reason: delta.stop_reason })
        }
        if (typeof delta.stop_sequence === 'string') this.stopSequence = delta.stop_sequence
        const usage = normalizeUsage(parsed.usage)
        if (usage) {
          // 累计快照：后续覆盖较早，绝不叠加
          this.usage = { ...this.usage, ...usage, raw: usage.raw ?? this.usage?.raw }
          out.push({ type: 'usage', usage: this.usage })
        }
        break
      }

      case 'message_stop': {
        this.completed = true
        // 收尾所有未 stop 的块（防御异常上游）
        for (const idx of [...this.orderedIndices]) {
          const st = this.blocks.get(idx)
          if (st) out.push(...this.finalizeBlock(st))
        }
        break
      }

      case 'ping':
        break

      case 'error': {
        this.errored = true
        const err = (parsed.error ?? {}) as Record<string, unknown>
        const errType = typeof err.type === 'string' ? err.type : 'api_error'
        const message = typeof err.message === 'string' ? err.message : 'Model error'
        out.push({ type: 'error', code: errType, message })
        break
      }

      default:
        // 未知事件类型：容错忽略
        break
    }

    return out
  }

  // 最终确定一个块：思考块补发 reasoning_completed，工具块解析 JSON 并 emit tool_call，
  // 其余（text / redacted_thinking / 未知）以 native_block 交给上层。
  private finalizeBlock(state: BlockState): CanonicalModelEvent[] {
    const out: CanonicalModelEvent[] = []
    if (state.finalized) return out
    state.finalized = true
    if (state.type === 'thinking') {
      const summaryText = state.thinkingText.trim()
      out.push({
        type: 'reasoning_completed',
        itemId: String(state.index),
        summary: summaryText ? [summaryText] : [],
      })
      // 思考块本身（含 signature）作为 native_block 持久化
      out.push({ type: 'native_block', block: this.snapshotBlock(state) })
      return out
    }

    if (state.type === 'tool_use') {
      let input: Record<string, unknown> | null = null
      if (state.jsonBuffer.trim()) {
        // 流式：参数来自 input_json_delta，只有完整 JSON 才算有效工具调用。
        try {
          const parsedInput = JSON.parse(state.jsonBuffer)
          if (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) {
            input = parsedInput as Record<string, unknown>
          } else {
            input = {}
          }
        } catch {
          // JSON 不完整（中断）：不当作有效工具调用，仍保留原始块供诊断。
          input = null
        }
      } else if (state.startInput) {
        // 非流式：content_block_start 已带完整 input。
        input = state.startInput
      } else {
        // 无参数且无初始 input：合法的空参数工具调用 {}。
        input = {}
      }

      state.block.input = input ?? {}
      const id = typeof state.block.id === 'string' ? state.block.id : ''
      const name = typeof state.block.name === 'string' ? state.block.name : ''
      if (id && name && input !== null) {
        out.push({ type: 'tool_call', callId: id, name, arguments: JSON.stringify(input) })
      }
      out.push({ type: 'native_block', block: this.snapshotBlock(state) })
      return out
    }

    // text / redacted_thinking / document / 未知类型：保留原始块
    out.push({ type: 'native_block', block: this.snapshotBlock(state) })
    return out
  }

  private snapshotBlock(state: BlockState): CanonicalNativeBlock {
    const copy: CanonicalNativeBlock = { ...state.block, type: state.type }
    // text 块以累积文本为准
    if (state.type === 'text') {
      copy.text = typeof state.block.text === 'string' ? state.block.text : ''
    }
    return copy
  }

  getResult(): AnthropicStreamResult {
    const blocks: CanonicalNativeBlock[] = []
    for (const idx of this.orderedIndices) {
      const st = this.blocks.get(idx)
      if (st) blocks.push(st.block)
    }
    return {
      messageId: this.messageId,
      model: this.model,
      stopReason: this.stopReason,
      stopSequence: this.stopSequence,
      usage: this.usage,
      blocks,
      completed: this.completed,
      errored: this.errored,
    }
  }

  hasErrored(): boolean {
    return this.errored
  }
}
