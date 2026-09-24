/**
 * ChatCompletionReasoningNormalizer — 单次 stream 调用的 structured reasoning 归一化状态机。
 *
 * OpenChat 只解析 Chat Completions 中存在明确结构化字段的 reasoning transport：
 *   - delta.reasoning / message.reasoning              （vLLM 现任 canonical 字段）
 *   - delta.reasoning_content / message.reasoning_content （Qwen / DeepSeek / GLM 等）
 *
 * 明确不做：
 *   - 不解析 content 中的 inline <think>...</think>（视为普通 final content，原样透传）
 *   - 不 strip / 不删除 / 不拆分任何 tag
 *   - 不调用 Adapter / Transport / Renderer / Repository
 *   - 不按 model / provider 名字判断
 *   - 不自动匹配未知 reasoning-like key
 *   - 不解析 Responses 协议（那是 ResponsesAdapter 的职责）
 *
 * 产品边界：客户端无法可靠判断上游 content 里哪些 token 是 reasoning、哪些是 final，
 * 因此不做 inline tag recovery。上游把 thinking tag 塞进 content 属于其响应质量问题，
 * 不是 OpenChat 的 parsing responsibility。
 *
 * 生命周期：每个 stream() 调用 new 一个实例（per-request state，绝不 module-global）。
 *
 * 产出的是「轻量事件」，最终映射为 CanonicalModelEvent：
 *   { type: 'reasoning_started' | 'reasoning_delta' | 'reasoning_completed' | 'delta' }
 */

import { extractStructuredReasoning, KNOWN_UNPARSED_REASONING_FIELDS, findUnknownReasoningLikeField } from './reasoningExtraction'
import { reasoningDebug } from './ReasoningDebug'

export type ReasoningNormalizeEvent =
  | { type: 'reasoning_started' }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_completed' }
  | { type: 'delta'; text: string }

interface DeltaChunk {
  content?: unknown
  reasoning?: unknown
  reasoning_content?: unknown
  reasoning_details?: unknown
  [key: string]: unknown
}

// inline <think> 只作为 Debug 观察的信号，绝不驱动解析行为。
const INLINE_THINK_PREFIX = '<think>'

export class ChatCompletionReasoningNormalizer {
  private structuredActive = false
  private finalStarted = false
  // reasoning_started 是否已 emit（保证整轮只 start 一次，绝不重复）
  private startedEmitted = false
  // Debug-only：是否已记录「content 起始疑似 <think> 泄漏」（仅提示，不改行为）。
  private inlineLeakLogged = false

  /**
   * 处理 streaming delta。返回该 delta 应产出的 canonical 事件序列（可能为空 / 多个）。
   * 不抛异常；内部对畸形 payload 做防御。
   */
  process(delta: DeltaChunk | null | undefined): ReasoningNormalizeEvent[] {
    if (!delta || typeof delta !== 'object') return []
    const events: ReasoningNormalizeEvent[] = []

    const deltaKeys = Object.keys(delta)
    const structured = extractStructuredReasoning(delta as Record<string, unknown>)

    // 已知但未解析字段：仅 debug 记录，绝不显示
    const hasUnparsedDetails = deltaKeys.some((k) => KNOWN_UNPARSED_REASONING_FIELDS.has(k))
    const unknownLike = findUnknownReasoningLikeField(deltaKeys)

    if (structured.source) {
      reasoningDebug({
        protocol: 'chat_completions',
        deltaKeys,
        reasoningField: structured.source,
        reasoningLength: structured.text?.length ?? 0,
        contentLength: typeof delta.content === 'string' ? delta.content.length : 0,
        phase: 'reasoning',
        ...(structured.multipleStructuredReasoningFields ? { multipleStructuredReasoningFields: true } : {}),
        ...(unknownLike ? { unknownReasoningLikeField: unknownLike } : {}),
      })
    } else if (unknownLike) {
      reasoningDebug({ protocol: 'chat_completions', unknownReasoningLikeField: unknownLike })
    }
    if (hasUnparsedDetails) {
      const raw = delta.reasoning_details
      reasoningDebug({
        protocol: 'chat_completions',
        reasoningDetailsPresent: true,
        reasoningDetailsItemTypes: Array.isArray(raw)
          ? Array.from(new Set(raw.map((it) => (it && typeof it === 'object' ? String((it as { type?: unknown }).type ?? 'unknown') : typeof it))))
          : [typeof raw],
        note: 'reasoning_details not parsed this round',
      })
    }

    // 1) structured reasoning —— 独立处理，绝不与 content 互斥
    if (structured.text) {
      // final 正文已开始 → late structured reasoning anomaly：
      // 保守不回退 visible reasoning（不回退已经 emitting 的 final phase）。
      if (this.finalStarted) {
        reasoningDebug({ protocol: 'chat_completions', phase: 'final', finalThenReasoningAnomaly: true, note: 'late reasoning ignored' })
      } else {
        events.push(...this.beginStructured())
        events.push({ type: 'reasoning_delta', text: structured.text })
      }
    }

    // 2) content —— 永远是 final 正文，原样透传。出现时若 reasoning 仍 active 先 close。
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push(...this.handleContent(delta.content))
    }

    return events
  }

  /**
   * 流结束 / finish_reason / abort / error 时调用。补齐尚未完成的 structured reasoning phase。
   * 幂等：completed 最多 emit 一次。
   */
  finalize(_opts?: { closedBy?: 'finish_reason' | 'stream_end' | 'abort' | 'error' }): ReasoningNormalizeEvent[] {
    const events: ReasoningNormalizeEvent[] = []
    if (this.structuredActive) {
      events.push({ type: 'reasoning_completed' })
      this.structuredActive = false
    }
    return events
  }

  // ── structured path ──

  private beginStructured(): ReasoningNormalizeEvent[] {
    const events: ReasoningNormalizeEvent[] = []
    if (!this.structuredActive && !this.startedEmitted) {
      this.structuredActive = true
      this.startedEmitted = true
      events.push({ type: 'reasoning_started' })
    } else {
      this.structuredActive = true
    }
    return events
  }

  // ── content path ──

  private handleContent(content: string): ReasoningNormalizeEvent[] {
    const events: ReasoningNormalizeEvent[] = []
    // 同一 chunk 先 structured 后 content：先 close reasoning，再作为 final 正文。
    if (this.structuredActive) {
      events.push({ type: 'reasoning_completed' })
      this.structuredActive = false
      reasoningDebug({ protocol: 'chat_completions', phase: 'final', events: ['reasoning_completed'], note: 'content after structured reasoning' })
    }
    this.maybeLogInlineLeak(content)
    events.push(...this.emitFinal(content))
    return events
  }

  private emitFinal(content: string): ReasoningNormalizeEvent[] {
    this.finalStarted = true
    return [{ type: 'delta', text: content }]
  }

  // Debug-only：response 起始（未出现 structured、也未有 final）时，单个 raw content 明确以
  // <think> 开头 → 记录一次可能的上游 inline 泄漏。绝不 buffer / strip / parse / 改写 content。
  // 不跨 chunk 拼接（宁愿漏报 "<thi"+"nk>"，也不为此保留 parser 状态）。
  private maybeLogInlineLeak(content: string): void {
    if (this.inlineLeakLogged) return
    if (this.startedEmitted || this.finalStarted) return
    if (!content.replace(/^[\s\r\n\t]+/, '').startsWith(INLINE_THINK_PREFIX)) return
    this.inlineLeakLogged = true
    reasoningDebug({
      protocol: 'chat_completions',
      possibleInlineThinkLeak: true,
      phase: 'content',
      note: 'content starts with <think>; treated as raw content (no inline parsing)',
    })
  }
}
