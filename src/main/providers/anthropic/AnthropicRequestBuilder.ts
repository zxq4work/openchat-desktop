// Anthropic Messages API 请求体构建（版本感知）。
//
// 约束：
// - 只写 Anthropic 明确支持的字段；绝不透传 OpenAI 字段（max_completion_tokens / response_format …）。
// - 未配置 system / tools → 不发送对应字段。
// - 2026-10-21 版本：请求构建阶段彻底移除 temperature / top_p / top_k（含动态参数注入的值）。
// - thinking 与强制 tool_choice 互斥；budget 至少 1024 且必须小于 max_tokens。
// - 工具定义字段是 input_schema，不是 OpenAI 的 function.parameters。

import type {
  AnthropicRequestOptions,
  CanonicalMessage,
  CanonicalModelRequest,
  OpenChatToolDefinition,
} from '../../../shared/types/provider'
import { isSamplingParamsRemoved, toAnthropicEffort } from '../../../shared/providers/anthropicEndpoint'

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024

export type AnthropicContentBlock = Record<string, unknown>

export interface AnthropicMessagesBody {
  model: string
  max_tokens: number
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }>
  stream: boolean
  system?: string | AnthropicContentBlock[]
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
  tool_choice?: Record<string, unknown>
  thinking?: Record<string, unknown>
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  output_config?: Record<string, unknown>
  metadata?: Record<string, unknown>
  cache_control?: Record<string, unknown>
  [key: string]: unknown
}

export class AnthropicRequestError extends Error {
  code = 'ANTHROPIC_REQUEST_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'AnthropicRequestError'
  }
}

// 读取该 assistant 消息是否可原生重放（源协议一致 + 模型一致）。
export function canReplayNativeBlocks(msg: CanonicalMessage, targetModel: string): boolean {
  if (!msg.nativeBlocks || msg.nativeBlocks.length === 0) return false
  if (msg.nativeBlocksProtocol !== 'anthropic_messages') return false
  // thinking signature 绑定模型：模型不一致时不重放原生块（避免伪造 / 服务端拒签）。
  if (msg.nativeBlocksModelId && msg.nativeBlocksModelId !== targetModel) return false
  return true
}

// 将 CanonicalMessage 序列化为 Anthropic content blocks。
// imageResolver 由 Adapter 注入：attachmentId → base64 数据 + mimeType。
export interface AnthropicImageEncoder {
  encode(attachmentId: string): { mediaType: string; data: string } | null
}

const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

// 主流程：canonical request → Anthropic body（不含 version 相关剔除后的最终裁剪）。
export function buildAnthropicRequestBody(
  request: CanonicalModelRequest,
  imageEncoder: AnthropicImageEncoder,
  authOptions?: AnthropicRequestOptions
): AnthropicMessagesBody {
  const messages: AnthropicMessagesBody['messages'] = []
  for (const msg of request.messages) {
    // 完整原生 transcript（单轮内的多轮工具往返）优先精确重放，逐项展开为消息。
    if (
      msg.role === 'assistant' &&
      msg.nativeBlocksProtocol === 'anthropic_messages' &&
      msg.nativeTranscript &&
      msg.nativeTranscript.length > 0 &&
      (!msg.nativeBlocksModelId || msg.nativeBlocksModelId === request.model)
    ) {
      for (const item of msg.nativeTranscript) {
        if (!item || !Array.isArray(item.blocks) || item.blocks.length === 0) continue
        if (item.role !== 'user' && item.role !== 'assistant') continue
        messages.push({ role: item.role, content: item.blocks.map((b) => ({ ...b })) })
      }
      continue
    }

    const serialized = serializeMessage(msg, request.model, imageEncoder)
    if (!serialized) continue
    // Anthropic 要求连续的 tool_result 合并进同一条 user 消息（多个工具并行调用时）。
    // 客户端不应依赖服务端自动合并同角色消息，这里显式合并。
    const prev = messages[messages.length - 1]
    if (
      prev &&
      prev.role === 'user' &&
      serialized.role === 'user' &&
      isToolResultOnly(serialized.content) &&
      prev.content.every((b) => b.type === 'tool_result')
    ) {
      prev.content.push(...serialized.content)
      continue
    }
    messages.push(serialized)
  }

  const opts = request.anthropic ?? authOptions ?? {}
  const maxTokens = resolveMaxTokens(request.maxOutputTokens, opts.maxOutputTokens)
  const thinking = resolveThinking(opts, maxTokens)

  const body: AnthropicMessagesBody = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  }

  // system：仅当非空发送。优先顶层 system（旧版 Messages API 兼容）。
  const system = (request.systemPrompt ?? '').trim()
  if (system) body.system = system

  // tools：仅当存在时发送，字段名为 input_schema。
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toAnthropicTool)
    body.tool_choice = resolveToolChoice(request.toolChoice, thinking)
  } else if (request.toolChoice === 'none') {
    body.tool_choice = { type: 'none' }
  }

  if (thinking) body.thinking = thinking

  // reasoning effort：顶层 output_config.effort（与 thinking 独立的字段）。
  // 与其它协议一致：只要会话选择了受支持的等级就发送，未选择 / 非法值不发送。
  // effort 不是采样参数，2026-10-21 的采样参数剔除不会移除它。
  const effort = toAnthropicEffort(request.reasoningEffort)
  if (effort) body.output_config = { effort }

  // 采样参数：仅在旧版本发送，且 thinking 启用时不发送（Anthropic 不允许）。
  const samplingRemoved = isSamplingParamsRemoved(opts.apiVersion)
  if (!samplingRemoved && !thinking && request.temperature != null) {
    body.temperature = request.temperature
  }

  // 动态参数：最后注入（Adapter 不认识具体参数名，只按 path 写入）。
  // 注意：2026-10-21 的采样参数剔除在 applyDynamicParameters 之后统一执行。
  const bodyRecord = body as unknown as Record<string, unknown>
  if (request.dynamicParameters && request.dynamicParameters.length > 0) {
    for (const p of request.dynamicParameters) {
      applyPath(bodyRecord, p.path, p.value)
    }
  }

  // 版本感知强制剔除（覆盖动态参数注入的采样字段与默认值）。
  // 绝不触碰 output_config.effort（它不是采样参数）。
  if (samplingRemoved) {
    delete bodyRecord.temperature
    delete bodyRecord.top_p
    delete bodyRecord.top_k
  }

  // Prompt Caching：默认关闭。开启时添加有界断点（system + 最后一条 message）。
  if (opts.promptCaching) {
    applyPromptCaching(body)
  }

  return body
}

function isToolResultOnly(content: AnthropicContentBlock[]): boolean {
  return content.length > 0 && content.every((b) => b.type === 'tool_result')
}

function resolveMaxTokens(requestMax: number | undefined, configMax: number | undefined): number {
  const candidates = [requestMax, configMax].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
  const value = candidates[0] ?? ANTHROPIC_DEFAULT_MAX_TOKENS
  return Math.max(1, Math.floor(value))
}

// thinking 解析：返回要写入 body 的 thinking 字段；undefined = 不发送。
function resolveThinking(opts: AnthropicRequestOptions, maxTokens: number): Record<string, unknown> | undefined {
  const cfg = opts.thinking
  if (!cfg || cfg.mode === 'off') return undefined
  if (cfg.mode === 'adaptive') {
    return { type: 'adaptive' }
  }
  // budget 模式
  const budgetRaw = typeof cfg.budgetTokens === 'number' ? Math.floor(cfg.budgetTokens) : ANTHROPIC_MIN_THINKING_BUDGET
  const budget = Math.max(ANTHROPIC_MIN_THINKING_BUDGET, budgetRaw)
  if (budget >= maxTokens) {
    throw new AnthropicRequestError(
      `思考预算（${budget}）必须小于最大输出 Token（${maxTokens}），请调大最大输出或减小思考预算。`
    )
  }
  return { type: 'enabled', budget_tokens: budget }
}

// tool_choice 与 thinking 兼容性：启用 thinking 时绝不使用强制工具调用模式。
function resolveToolChoice(
  choice: CanonicalModelRequest['toolChoice'],
  thinking: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (choice === 'required') {
    if (thinking) {
      // thinking 与 any/tool 强制模式不兼容 → 降级为 auto（显式、可追踪）。
      return { type: 'auto' }
    }
    return { type: 'any' }
  }
  if (choice === 'none') return { type: 'none' }
  return { type: 'auto' }
}

function toAnthropicTool(tool: OpenChatToolDefinition): { name: string; description?: string; input_schema: Record<string, unknown> } {
  const def: { name: string; description?: string; input_schema: Record<string, unknown> } = {
    name: tool.name,
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  }
  if (tool.description) def.description = tool.description
  return def
}

// 单条消息序列化。返回 null 表示该消息序列化后无内容（跳过）。
function serializeMessage(
  msg: CanonicalMessage,
  targetModel: string,
  imageEncoder: AnthropicImageEncoder
): { role: 'user' | 'assistant'; content: AnthropicContentBlock[] } | null {
  // system / developer 已在顶层 system 处理，绝不塞进 messages 数组。
  if (msg.role === 'system' || msg.role === 'developer') return null

  // 完整原生 transcript 重放（含中间工具轮）：由调用方拆成多条消息，不进入本函数。
  // 原生块重放：仅当源协议一致且模型一致（thinking signature 才安全）。
  if (msg.role === 'assistant' && canReplayNativeBlocks(msg, targetModel) && msg.nativeBlocks) {
    const content = msg.nativeBlocks
      .filter((b) => typeof b.type === 'string')
      .map((b) => ({ ...b }))
    if (content.length > 0) return { role: 'assistant', content }
  }

  const content: AnthropicContentBlock[] = []

  // 工具调用（assistant）→ tool_use 块（Anthropic 要求全量 assistant 内容块）
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    const blocks: AnthropicContentBlock[] = []
    if (msg.content) blocks.push({ type: 'text', text: msg.content })
    for (const tc of msg.toolCalls) {
      let input: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(tc.arguments)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
      } catch {
        input = {}
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
    }
    return { role: 'assistant', content: blocks }
  }

  // 工具结果（tool → user 消息 + tool_result 块）
  if (msg.toolResult) {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.toolResult.callId,
        content: msg.toolResult.output,
        ...(msg.toolResult.isError ? { is_error: true } : {}),
      }],
    }
  }

  // 多模态 user 内容
  if (msg.role === 'user' && msg.inputParts && msg.inputParts.length > 0) {
    const parts: AnthropicContentBlock[] = []
    for (const part of msg.inputParts) {
      if (part.type === 'text') {
        if (part.text) parts.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        const encoded = imageEncoder.encode(part.attachmentId)
        if (!encoded) {
          // 绝静默降级为纯文本：图片无法编码时必须显式失败。
          throw new AnthropicImageError('图片附件无法读取或编码')
        }
        if (!SUPPORTED_IMAGE_MIMES.has(encoded.mediaType)) {
          throw new AnthropicImageError(`不支持的图片类型：${encoded.mediaType}`)
        }
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: encoded.mediaType, data: encoded.data },
        })
      }
    }
    if (parts.length > 0) return { role: 'user', content: parts }
  }

  if (msg.role === 'assistant') {
    return { role: 'assistant', content: [{ type: 'text', text: msg.content ?? '' }] }
  }

  const text = msg.content ?? ''
  return { role: 'user', content: [{ type: 'text', text }] }
}

export class AnthropicImageError extends Error {
  code = 'ANTHROPIC_IMAGE_UNSUPPORTED'
  constructor(message: string) {
    super(message)
    this.name = 'AnthropicImageError'
  }
}

// 通用动态参数注入：只允许顶层字段或 extra_body.<字段>（与项目其它协议一致的安全约束）。
function applyPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const trimmed = (path ?? '').trim()
  if (!trimmed) return
  const segments = trimmed.split('.')
  if (segments.length === 2) {
    const container = segments[0]
    if (container !== 'extra_body') return
    const existing = body[container]
    const base = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}
    body[container] = { ...base, [segments[1]]: value }
    return
  }
  if (segments.length === 1) {
    body[segments[0]] = value
  }
}

// Prompt Caching：ephemeral 断点。最多 2 个（system 末尾 + messages 最后一条）。
function applyPromptCaching(body: AnthropicMessagesBody): void {
  if (typeof body.system === 'string' && body.system) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }]
  }
  const last = body.messages[body.messages.length - 1]
  if (last && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1]
    if (lastBlock && typeof lastBlock === 'object') {
      lastBlock.cache_control = { type: 'ephemeral' }
    }
  }
}