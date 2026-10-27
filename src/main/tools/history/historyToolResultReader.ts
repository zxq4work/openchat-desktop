// 只读历史工具结果读取（纯函数，无副作用）。
//
// 目标：无论用户是否切换 Provider，都能按需读取**完整、真实、已持久化**的历史工具结果。
// 上下文管理只决定「默认发送多少」，不能限制「用户最多能读多少」——二者严格分离。
//
// 数据来源（全部来自本地持久化，绝不再联网、绝不重新执行工具、绝不从模型此前的回答推断）：
//   - provider_payload_json：provider-native tool history（V2 schema）。
//       * function_call + function_call_output：client-executed 工具（Codex run / openchat_*）的真实输出原文。
//       * web_search_call：Hosted 服务端搜索。**只有来源元数据**（action.sources），无完整网页正文。
//   - web_search_results_json：**整条助手消息**聚合展示过的来源列表（title/url/snippet/sourceType）。
//
// 来源归属（关键，务必区分）：
//   - callSources：**该单次工具调用自身**返回的来源。仅当持久化里确实保存了可归属于该调用的
//     来源时才有值（如 Hosted web_search_call 的 action.sources）。client tool（function_call）
//     的持久化中**从未保存过按调用归属的来源**，故为 null（归属未知，绝不伪造）。
//   - messageSources：**整条助手消息的聚合来源**（web_search_results_json）。只能标识为
//     message-level，绝不能冒充某次调用的自身返回。
//
// 本模块只读取；不写入、不 re-run、不访问其它会话（调用方保证 scope 限定在当前会话）。

import type { Message, WebSearchResultItem } from '../../../shared/types/conversation'
import type { ProviderPayloadItem, ProviderPayloadV2 } from '../../../shared/types/provider'

export type HistoryCallKind = 'tool' | 'hosted_search'

// 一条历史工具调用的索引条目（供 list 使用，不含大体积 output 正文）。
export interface HistoryToolCallSummary {
  callId: string
  kind: HistoryCallKind
  name: string
  namespace?: string
  arguments: string
  // 原始 output 字符长度（如实来自持久化文本，非估算）。hosted_search 恒为 0（无正文）。
  outputLength: number
  // 是否为错误输出（output 以 "Error:" 开头，或解析后含 error 字段）。
  isError: boolean
  // 产生该调用的源 Provider / Protocol（来自 provider_payload_json）。
  sourceProvider?: string
  sourceProtocol?: string
  // assistant 消息时间戳（用于区分同一会话内的多次调用）。
  createdAt: number
  // 该单次调用**自身**返回的来源数量；null 表示持久化中未保存按调用的来源（归属未知）。
  callSourceCount: number | null
  // 整条助手消息聚合来源的数量（message-level，非该调用自身）。
  messageSourceCount: number
}

interface PairedCall {
  callId: string
  kind: HistoryCallKind
  name: string
  namespace?: string
  arguments: string
  output: string
  sourceProvider?: string
  sourceProtocol?: string
  createdAt: number
  // 该调用自身来源（仅当持久化确实保存了按调用的来源时；否则 null）。
  callSources: WebSearchResultItem[] | null
}

// 把 Hosted action.sources 归一为展示条目。无 sources 时返回 undefined（归属未知）。
function hostedActionSources(action: { sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> } | undefined): WebSearchResultItem[] | undefined {
  const sources = action?.sources
  if (!Array.isArray(sources)) return undefined
  return sources.map((s) => ({
    title: (typeof s.title === 'string' ? s.title : null) ?? (typeof s.name === 'string' ? s.name : null),
    url: typeof s.url === 'string' ? s.url : null,
    snippet: typeof s.snippet === 'string' ? s.snippet : null,
    sourceType: s.type === 'api' ? 'api' : 'web',
  }))
}

// 从 provider_payload_json 解析出历史调用。
// 只处理 V2 schema（items）。legacy schema 不在此读取（历史兼容由 buildCanonicalRequest 处理）。
function parsePairedCalls(payloadJson: string | null, createdAt: number): PairedCall[] {
  if (!payloadJson) return []
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>
  } catch {
    return []
  }
  if (!payload.items || !Array.isArray(payload.items)) return []

  const v2 = payload as unknown as ProviderPayloadV2
  const sourceProvider = typeof payload.provider === 'string' ? payload.provider : undefined
  const sourceProtocol = typeof payload.protocol === 'string' ? payload.protocol : undefined

  const outputByCallId = new Map<string, string>()
  const calls: PairedCall[] = []

  for (const item of v2.items as ProviderPayloadItem[]) {
    if (item.type === 'function_call') {
      calls.push({
        callId: item.call_id,
        kind: 'tool',
        name: item.name,
        namespace: item.namespace,
        arguments: item.arguments,
        output: '',
        sourceProvider,
        sourceProtocol,
        createdAt,
        // client tool：持久化中无按调用归属的来源 → 归属未知。
        callSources: null,
      })
    } else if (item.type === 'function_call_output') {
      outputByCallId.set(item.call_id, item.output)
    } else if (item.type === 'web_search_call') {
      // Hosted 服务端搜索：无正文，仅来源元数据。action.sources 即该次调用自身返回的来源。
      const own = hostedActionSources(item.action)
      calls.push({
        callId: item.id,
        kind: 'hosted_search',
        name: 'web_search',
        arguments: typeof item.action?.query === 'string' ? JSON.stringify({ query: item.action.query }) : '{}',
        output: '',
        sourceProvider,
        sourceProtocol,
        createdAt,
        callSources: own ?? null,
      })
    }
  }
  for (const call of calls) {
    const out = outputByCallId.get(call.callId)
    if (typeof out === 'string') call.output = out
  }
  return calls
}

// 仅为判定 isError 的轻量解析；不改写 output 原文。
function isErrorOutput(output: string): boolean {
  if (!output) return false
  if (output.startsWith('Error:')) return true
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    return typeof parsed.error === 'string' && parsed.error.length > 0
  } catch {
    return false
  }
}

// 收集一个会话内、按时间升序的全部历史工具调用（含真实 output）。
export function collectHistoryToolCalls(messages: Message[]): HistoryToolCallSummary[] {
  const summaries: HistoryToolCallSummary[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!msg.providerPayloadJson && !msg.webSearchResults) continue
    const messageSources = msg.webSearchResults ?? []
    const pairs = parsePairedCalls(msg.providerPayloadJson, msg.createdAt)
    for (const p of pairs) {
      summaries.push({
        callId: p.callId,
        kind: p.kind,
        name: p.name,
        namespace: p.namespace,
        arguments: p.arguments,
        outputLength: p.output.length,
        isError: isErrorOutput(p.output),
        sourceProvider: p.sourceProvider,
        sourceProtocol: p.sourceProtocol,
        createdAt: p.createdAt,
        callSourceCount: p.callSources ? p.callSources.length : null,
        messageSourceCount: messageSources.length,
      })
    }
  }
  return summaries
}

// 按 callId 读取真实历史 output（完整原文 + 分页）。找不到时返回 null。
export interface HistoryCallChunk {
  found: true
  callId: string
  kind: HistoryCallKind
  name: string
  namespace?: string
  arguments: string
  // 分页片段：[offset, offset+limit) 内的真实原文。hosted_search 恒为空串。
  content: string
  offset: number
  limit: number
  returnedLength: number
  totalLength: number
  hasMore: boolean
  nextOffset: number | null
  sourceProvider?: string
  sourceProtocol?: string
  createdAt: number
  // 该单次调用自身来源；null 表示归属未知（持久化未保存按调用来源）。
  callSources: WebSearchResultItem[] | null
  // 整条助手消息的聚合来源（message-level）。
  messageSources: WebSearchResultItem[]
}

// 单次读取的硬上限。只限制「一次返回多少」，不限制「总计能读多少」——
// 连续分页（nextOffset）仍可读取完整历史，避免单次超大响应撑爆上下文。
export const MAX_HISTORY_CALL_CHUNK_LIMIT = 20000

export function readHistoryCallChunk(
  messages: Message[],
  callId: string,
  offset: number,
  limit: number
): HistoryCallChunk | null {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  const requestedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4000
  const safeLimit = Math.min(requestedLimit, MAX_HISTORY_CALL_CHUNK_LIMIT)

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.providerPayloadJson) continue
    const messageSources = msg.webSearchResults ?? []
    const pairs = parsePairedCalls(msg.providerPayloadJson, msg.createdAt)
    const match = pairs.find((p) => p.callId === callId)
    if (!match) continue

    const total = match.output.length
    const end = Math.min(safeOffset + safeLimit, total)
    const content = match.output.slice(safeOffset, end)
    const hasMore = end < total
    return {
      found: true,
      callId: match.callId,
      kind: match.kind,
      name: match.name,
      namespace: match.namespace,
      arguments: match.arguments,
      content,
      offset: safeOffset,
      limit: safeLimit,
      returnedLength: content.length,
      totalLength: total,
      hasMore,
      nextOffset: hasMore ? end : null,
      sourceProvider: match.sourceProvider,
      sourceProtocol: match.sourceProtocol,
      createdAt: match.createdAt,
      callSources: match.callSources,
      messageSources,
    }
  }
  return null
}
