import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  CanonicalMessage,
  CanonicalToolCall,
  CanonicalToolResult,
  CanonicalWebSearchCall,
} from '../../shared/types/provider'
import { ToolRegistry, type ToolExecutionContext } from './ToolRegistry'
import { READ_HISTORY_TOOL_NAME } from './history/ReadHistoryTool'

const MAX_TOOL_ROUNDS = 6
const MAX_WEB_SEARCH_CALLS_PER_TURN = 10
const MAX_WEB_FETCH_CALLS_PER_TURN = 10
const MAX_WEB_RUN_CALLS_PER_TURN = 10
// 只读历史工具（openchat_read_history）的独立、有界继续调用预算。
// 历史读取是纯本地只读操作，不联网、不改变外部状态，故允许在正常 maxRounds 之外
// 继续分页，直到读完整段历史或耗尽本预算；绝不影响普通网页搜索的轮次限制。
const MAX_HISTORY_READ_CALLS_PER_TURN = 12

// 工具参数/输出的宽松 JSON 解析：模型可能返回 null、数组或标量等非对象 JSON。
// 解析失败或结果不是普通对象时一律回退为 {}，绝不因非法形状抛异常中断整个生成。
function parseJsonObject(text: string | undefined | null): Record<string, unknown> {
  if (typeof text !== 'string' || !text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

export interface ToolLoopConfig {
  maxRounds?: number
  maxSearchCalls?: number
  // 单轮内 openchat_read_history 的最大调用次数（独立预算）。缺省用常量。
  maxHistoryReadCalls?: number
  // 是否把本轮内新产生的 provider-native web_search_call 追加到后续轮的 input 中重放。
  // 仅 Hosted 路径需要（原生搜索 + 历史读取同轮时，下一轮请求必须带上本轮的 web_search_call 上下文）；
  // 缺省 false，保持 Standalone / 自定义 Provider 的既有行为完全不变。
  replayHostedSearchCalls?: boolean
}

export interface ToolLoopCallbacks {
  onToolCall: (toolCall: CanonicalToolCall) => void
  onToolResult: (callId: string, toolName: string, success: boolean, rawResults?: unknown[], errorOutput?: string) => void
  onDelta: (text: string) => void
  onReasoningStarted: (itemId?: string) => void
  onReasoningDelta: (text: string) => void
  onReasoningCompleted: (itemId?: string, summary?: string[]) => void
  onTurnStarted: (turnId?: string) => void
  // provider-native web_search_call 事件（仅 Hosted 路径会产生）。整体透传原始事件，
  // 保留 itemId / status / action（含 action.sources）/ results，供 Hosted 路径完整还原
  // 原生搜索的 started/completed/failed 语义；现有调用方（如 Standalone 兜底）忽略参数不受影响。
  onWebSearchCall?: (event: WebSearchCallEvent) => void
  getProviderTurnId: () => string | null
  setProviderTurnId: (id: string) => void
}

// provider-native web_search_call 的 canonical 事件类型（从统一事件联合中提取，避免重复定义）。
export type WebSearchCallEvent = Extract<CanonicalModelEvent, { type: 'web_search_call' }>

export interface ToolCallHistoryEntry {
  callId: string
  name: string
  namespace?: string
  arguments: string
  output: string
  rawResults: unknown[]
  isError: boolean
}

export interface ToolLoopResult {
  finalText: string
  providerTurnId: string | null
  totalToolCalls: number
  toolCallHistory: ToolCallHistoryEntry[]
}

export class ToolLoopController {
  private adapter: ModelAdapter
  private toolRegistry: ToolRegistry
  private toolExclude: string[]
  private executionContext: ToolExecutionContext
  private config: ToolLoopConfig

  constructor(adapter: ModelAdapter, toolRegistry: ToolRegistry, toolExclude?: string[], executionContext?: ToolExecutionContext, config?: ToolLoopConfig) {
    this.adapter = adapter
    this.toolRegistry = toolRegistry
    this.toolExclude = toolExclude ?? []
    this.executionContext = executionContext ?? {}
    this.config = config ?? {}
  }

  async run(
    initialRequest: CanonicalModelRequest,
    signal: AbortSignal,
    callbacks: ToolLoopCallbacks
  ): Promise<ToolLoopResult> {
    const toolCallHistory: ToolCallHistoryEntry[] = []
    let totalToolCalls = 0
    let accumulatedContent = ''
    let providerTurnId: string | null = null

    let searchCallCount = 0
    let fetchCallCount = 0
    let webRunCallCount = 0
    const executedQueries = new Set<string>()
    let searchProviderChallenge = false
    let searchFailed = false

    let messages: CanonicalMessage[] = initialRequest.messages.slice()
    let round = 0
    const maxRounds = this.config.maxRounds ?? MAX_TOOL_ROUNDS
    this.config.maxRounds = maxRounds
    this.config.maxSearchCalls = this.config.maxSearchCalls ?? MAX_WEB_SEARCH_CALLS_PER_TURN
    const maxHistoryReadCalls = this.config.maxHistoryReadCalls ?? MAX_HISTORY_READ_CALLS_PER_TURN
    // 已消耗的「普通工具轮」数：只有包含非只读历史工具调用的轮次才计入，
    // 从而不影响既有普通网页搜索的 maxRounds 限制语义。
    let normalRoundCount = 0
    // 只读历史工具的独立调用状态：计数 + 进度去重（防止重复读取同一页造成无进展循环）。
    const historyState = { count: 0, max: maxHistoryReadCalls, seen: new Set<string>() }
    // 硬性循环上限（双保险）：即使出现异常的工具组合，也绝不无限循环。
    const hardRoundCap = maxRounds + maxHistoryReadCalls + 5

    while (round <= hardRoundCap) {
      if (signal.aborted) break

      const registryTools = this.toolRegistry.getDefinitions(this.toolExclude)
      const extraTools = initialRequest.tools ?? []
      const roundRequest: CanonicalModelRequest = {
        ...initialRequest,
        messages,
        tools: [...extraTools, ...registryTools],
        toolChoice: 'auto',
      }

      const toolCalls: CanonicalToolCall[] = []
      // 本轮新产生的 provider-native web_search_call（仅 replayHostedSearchCalls 时收集）。
      const roundWebSearchCalls: CanonicalWebSearchCall[] = []
      let roundDeltaCount = 0

      console.log('[ToolLoop] Round', round, 'starting, messages=', messages.length)

      for await (const event of this.adapter.stream(roundRequest, signal)) {
        if (signal.aborted) break

        switch (event.type) {
          case 'delta':
            accumulatedContent += event.text
            callbacks.onDelta(event.text)
            roundDeltaCount++
            break

          case 'turn_started':
            if (event.turnId && !providerTurnId) {
              providerTurnId = event.turnId
              callbacks.setProviderTurnId(event.turnId)
            }
            callbacks.onTurnStarted(event.turnId)
            break

          case 'tool_call': {
            if (event.callId && event.name) {
              console.log('[ToolLoop] tool_call event: name=%s namespace=%s callId=%s', event.name, event.namespace, event.callId)
              toolCalls.push({
                id: event.callId,
                name: event.name,
                namespace: event.namespace,
                arguments: event.arguments,
              })
            }
            break
          }

          case 'web_search_call':
            // Hosted 轮把本轮原生搜索按真实时序追加到下一轮 input，避免「先搜索后读历史」
            // 的第二轮请求丢失本轮搜索结果。其它路径不收集，行为完全不变。
            if (this.config.replayHostedSearchCalls && event.phase === 'completed' && event.itemId) {
              roundWebSearchCalls.push({
                id: event.itemId,
                status: event.status,
                action: event.action ? { ...event.action, type: event.action.type ?? 'search' } : { type: 'search' },
              })
            }
            callbacks.onWebSearchCall?.(event)
            break

          case 'reasoning_started':
            callbacks.onReasoningStarted(event.itemId)
            break

          case 'reasoning_delta':
            callbacks.onReasoningDelta(event.text)
            break

          case 'reasoning_completed':
            callbacks.onReasoningCompleted(event.itemId, event.summary)
            break

          case 'turn_completed':
            break

          case 'error':
            throw new Error(`Model error: ${event.code} - ${event.message}`)
        }
      }

      console.log('[ToolLoop] Round', round, 'done, deltas=', roundDeltaCount, 'toolCalls=', toolCalls.length, 'totalContent=', accumulatedContent.length)

      if (signal.aborted) break

      // 没有工具调用，模型已输出最终回答，退出循环
      if (toolCalls.length === 0) {
        console.log('[ToolLoop] round=%d decision=final-answer returning=true', round)
        break
      }

      round++

      // 只有包含「非只读历史工具」调用的轮次才消耗普通轮预算。
      // 纯粹的历史分页读取不计入，从而不挤占普通网页搜索的 maxRounds。
      const hasNormalTool = toolCalls.some((tc) => tc.name !== READ_HISTORY_TOOL_NAME)
      if (hasNormalTool) normalRoundCount++

      // 执行工具调用
      const toolResults = await this.executeTools(
        toolCalls,
        searchCallCount,
        fetchCallCount,
        webRunCallCount,
        executedQueries,
        signal,
        callbacks,
        toolCallHistory,
        searchProviderChallenge,
        searchFailed,
        historyState
      )
      totalToolCalls += toolCalls.length

      // 检测到搜索引擎验证，后续轮次不再搜索
      if (!searchProviderChallenge && toolResults.some((tr) => tr.isError && tr.output.includes('SEARCH_PROVIDER_CHALLENGE'))) {
        searchProviderChallenge = true
      }

      // 搜索一旦失败（超时、限流、JS错误等），后续轮次不再重试搜索
      if (!searchFailed && toolResults.some((tr) => tr.isError && tr.name === 'openchat_web_search')) {
        searchFailed = true
      }

      if (signal.aborted) break

      // 构建下一轮 messages：追加 assistant tool_calls 和 tool results。
      // Hosted 轮先追加本轮新产生的原生 web_search_call（真实时序中它先于 read_history 调用），
      // 使下一轮请求既带上本轮搜索结果、又带上 read_history 结果。其它路径不收集，行为不变。
      if (roundWebSearchCalls.length > 0) {
        messages.push({ role: 'assistant', webSearchCalls: roundWebSearchCalls })
      }
      messages.push({ role: 'assistant', toolCalls })

      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          content: tr.output,
          toolResult: {
            callId: tr.callId,
            name: tr.name,
            output: tr.output,
            isError: tr.isError,
          },
        })
      }

      // 已达普通轮上限：追加提示消息强制模型输出最终回答，不依赖 tool_choice:'none'
      // （部分模型忽略此参数）。只按 normalRoundCount 判定，历史分页读取不触发 wrap-up。
      // 历史读取预算耗尽不做 wrap-up：改由 executeTools 对越界调用返回明确的
      // HISTORY_READ_BUDGET_EXCEEDED 错误，模型据此如实告知「未读完」，再自行给出回答；
      // 若模型仍反复调用，硬性循环上限 hardRoundCap 兜底终止，绝不无限循环。
      if (normalRoundCount >= maxRounds) {
        console.log(
          '[ToolLoop] Reached maxRounds (normalRounds=%d/%d, historyReads=%d/%d), sending wrap-up request',
          normalRoundCount, maxRounds, historyState.count, historyState.max
        )
        messages.push({
          role: 'user',
          content: 'Please provide your final answer now based on the search results above. Do not use any tools.',
        })
        const wrapUpRequest: CanonicalModelRequest = {
          ...initialRequest,
          messages,
        }
        let wrapUpDeltas = 0
        let wrapUpReasoningDeltas = 0
        for await (const event of this.adapter.stream(wrapUpRequest, signal)) {
          if (signal.aborted) break
          switch (event.type) {
            case 'delta':
              accumulatedContent += event.text
              callbacks.onDelta(event.text)
              wrapUpDeltas++
              break
            case 'reasoning_started':
              callbacks.onReasoningStarted(event.itemId)
              break
            case 'reasoning_delta':
              callbacks.onReasoningDelta(event.text)
              wrapUpReasoningDeltas++
              break
            case 'reasoning_completed':
              callbacks.onReasoningCompleted(event.itemId, event.summary)
              break
            case 'web_search_call':
              // Hosted 收尾轮仍声明顶层 web_search，可能产生原生搜索事件。
              // 仅 Hosted（replayHostedSearchCalls）转发，避免丢失收尾轮的搜索结果与 UI 事件；
              // Standalone / 自定义 Provider 收尾轮行为保持完全不变。
              if (this.config.replayHostedSearchCalls) callbacks.onWebSearchCall?.(event)
              break
            case 'turn_completed':
              break
            case 'error':
              console.log('[ToolLoop] Wrap-up error:', event.code, event.message)
              break
            default:
              break
          }
        }
        console.log('[ToolLoop] Wrap-up finished, deltas=', wrapUpDeltas, 'reasoningDeltas=', wrapUpReasoningDeltas, 'content length=', accumulatedContent.length)
        break
      }
    }

    console.log('[ToolLoop] returning final result, finalTextLength=%d totalToolCalls=%d', accumulatedContent.length, totalToolCalls)
    return {
      finalText: accumulatedContent,
      providerTurnId,
      totalToolCalls,
      toolCallHistory,
    }
  }

  private async executeTools(
    toolCalls: CanonicalToolCall[],
    searchCallCount: number,
    fetchCallCount: number,
    webRunCallCount: number,
    executedQueries: Set<string>,
    signal: AbortSignal,
    callbacks: ToolLoopCallbacks,
    toolCallHistory: ToolCallHistoryEntry[],
    searchProviderChallenge: boolean,
    searchFailed: boolean,
    historyState: { count: number; max: number; seen: Set<string> }
  ): Promise<CanonicalToolResult[]> {
    const toolResults: CanonicalToolResult[] = []

    for (const tc of toolCalls) {
      // 只读历史工具：独立、有界的继续调用预算。
      //  - 超出预算 → 返回明确「预算耗尽、可能未读完」的错误（绝不静默成功）；
      //  - 重复读取同一 (callId, offset, limit)（无进展）→ 视为异常循环，返回明确错误。
      if (tc.name === READ_HISTORY_TOOL_NAME) {
        const parsedArgs = parseJsonObject(tc.arguments)
        const progressKey = `${String(parsedArgs.callId ?? '')}|${String(parsedArgs.offset ?? 0)}|${String(parsedArgs.limit ?? '')}`
        const overBudget = historyState.count >= historyState.max
        const noProgress = historyState.seen.has(progressKey)
        if (overBudget || noProgress) {
          const reason = overBudget
            ? `HISTORY_READ_BUDGET_EXCEEDED: reached the per-turn limit of ${historyState.max} history-read calls; the output may be incomplete.`
            : 'HISTORY_READ_NO_PROGRESS: the same page was requested again; aborting to avoid an infinite loop.'
          const blocked: CanonicalToolResult = {
            callId: tc.id, name: tc.name,
            output: JSON.stringify({ error: overBudget ? 'HISTORY_READ_BUDGET_EXCEEDED' : 'HISTORY_READ_NO_PROGRESS', message: reason }),
            isError: true,
          }
          toolResults.push(blocked)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, blocked.output)
          continue
        }
        historyState.count++
        historyState.seen.add(progressKey)
      }

      if (tc.name === 'openchat_web_search') {
        searchCallCount++
        if (searchProviderChallenge) {
          console.log('[ToolLoop] Skipping web_search due to provider challenge')
          const skippedResult: CanonicalToolResult = {
            callId: tc.id,
            name: tc.name,
            output: JSON.stringify({ error: 'SEARCH_PROVIDER_CHALLENGE', message: '搜索已被禁用，当前网络环境触发搜索引擎验证' }),
            isError: true,
          }
          toolResults.push(skippedResult)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, skippedResult.output)
          continue
        }
        if (searchFailed) {
          console.log('[ToolLoop] Skipping web_search due to previous failure')
          const skippedResult: CanonicalToolResult = {
            callId: tc.id,
            name: tc.name,
            output: JSON.stringify({ error: 'SEARCH_FAILED', message: '搜索已失败，后续轮次不再重试' }),
            isError: true,
          }
          toolResults.push(skippedResult)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, skippedResult.output)
          continue
        }
        if (searchCallCount > (this.config.maxSearchCalls ?? MAX_WEB_SEARCH_CALLS_PER_TURN)) {
          console.log('[ToolLoop] Max web_search calls reached')
          const skippedResult: CanonicalToolResult = {
            callId: tc.id,
            name: tc.name,
            output: JSON.stringify({ error: 'TOOL_LIMIT_EXCEEDED', message: 'Max web_search calls per turn reached' }),
            isError: true,
          }
          toolResults.push(skippedResult)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, skippedResult.output)
          continue
        }
      }

      if (tc.name === 'openchat_web_fetch') {
        fetchCallCount++
        if (fetchCallCount > MAX_WEB_FETCH_CALLS_PER_TURN) {
          console.log('[ToolLoop] Max web_fetch calls reached')
          const skippedResult: CanonicalToolResult = {
            callId: tc.id,
            name: tc.name,
            output: JSON.stringify({ error: 'TOOL_LIMIT_EXCEEDED', message: 'Max web_fetch calls per turn reached' }),
            isError: true,
          }
          toolResults.push(skippedResult)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, skippedResult.output)
          continue
        }
      }

      if (tc.name === 'run' && tc.namespace === 'web') {
        webRunCallCount++
        if (webRunCallCount > MAX_WEB_RUN_CALLS_PER_TURN) {
          console.log('[ToolLoop] Max web.run calls reached')
          const skippedResult: CanonicalToolResult = {
            callId: tc.id,
            name: tc.name,
            output: 'Error: Max web.run calls per turn reached',
            isError: true,
          }
          toolResults.push(skippedResult)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, skippedResult.output)
          continue
        }
      }

      callbacks.onToolCall(tc)
      console.log('[Tool Call] name=', tc.name)

      const executor = this.toolRegistry.getExecutor(tc.name)
      if (!executor) {
        console.log('[Tool Call] Unknown tool:', tc.name)
        const result: CanonicalToolResult = {
          callId: tc.id,
          name: tc.name,
          output: JSON.stringify({ error: 'UNKNOWN_TOOL', message: `Unknown tool: ${tc.name}` }),
          isError: true,
        }
        toolResults.push(result)
        callbacks.onToolResult(tc.id, tc.name, false, undefined, result.output)
        continue
      }

      // 相同 query 去重
      const args = parseJsonObject(tc.arguments)

      const queryStr = args.query ? String(args.query).trim().toLowerCase() : ''
      if (tc.name === 'openchat_web_search' && queryStr) {
        if (executedQueries.has(queryStr)) {
          console.log('[Tool Call] Duplicate query, skipping:', queryStr)
          const skippedResult: CanonicalToolResult = {
            callId: tc.id,
            name: tc.name,
            output: JSON.stringify({ error: 'DUPLICATE_QUERY', message: 'Duplicate query skipped' }),
            isError: true,
          }
          toolResults.push(skippedResult)
          callbacks.onToolResult(tc.id, tc.name, false, undefined, skippedResult.output)
          continue
        }
        executedQueries.add(queryStr)
      }

      try {
        const result = await executor.execute(args, { signal, ...this.executionContext })
        result.callId = tc.id
        result.name = tc.name
        toolResults.push(result)

        console.log('[Tool Result] name=', tc.name, '| output length=', result.output.length)

        let rawResults: unknown[] = result.rawResults ?? []
        if (rawResults.length === 0) {
          const parsed = parseJsonObject(result.output)
          if (Array.isArray(parsed.results)) {
            rawResults = parsed.results
          } else if (parsed.url && typeof parsed.url === 'string') {
            rawResults = [{ url: parsed.url, title: (parsed.title as string) || (parsed.url as string), snippet: ((parsed.content as string) || '').slice(0, 150) }]
          }
        }

        toolCallHistory.push({
          callId: tc.id,
          name: tc.name,
          namespace: tc.namespace,
          arguments: tc.arguments,
          output: result.output,
          rawResults,
          isError: result.isError ?? false,
        })

        let errorOutput: string | undefined
        if (result.isError) {
          // 优先使用 error code，确保 guard 检查能匹配（如 SEARCH_TIMEOUT、TOOL_LIMIT_EXCEEDED）
          const parsed = parseJsonObject(result.output)
          errorOutput = (parsed.error as string) || (parsed.message as string) || result.output
        }
        if (result.isError && result.output.includes('SEARCH_PROVIDER_CHALLENGE')) {
          searchProviderChallenge = true
        }
        callbacks.onToolResult(tc.id, tc.name, !result.isError, rawResults, errorOutput)
      } catch (err) {
        console.error('[Tool Error]', err instanceof Error ? err.message : String(err))
        const errorResult: CanonicalToolResult = {
          callId: tc.id,
          name: tc.name,
          output: JSON.stringify({
            error: 'TOOL_EXECUTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
          }),
          isError: true,
        }
        toolResults.push(errorResult)
        callbacks.onToolResult(tc.id, tc.name, false, undefined, errorResult.output)
      }
    }

    return toolResults
  }
}