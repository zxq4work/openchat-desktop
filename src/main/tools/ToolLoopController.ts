import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  CanonicalMessage,
  CanonicalToolCall,
  CanonicalToolResult,
} from '../../shared/types/provider'
import { ToolRegistry } from './ToolRegistry'

const MAX_TOOL_ROUNDS = 4
const MAX_WEB_SEARCH_CALLS_PER_TURN = 10
const MAX_WEB_FETCH_CALLS_PER_TURN = 10

export interface ToolLoopCallbacks {
  onToolCall: (toolCall: CanonicalToolCall) => void
  onToolResult: (callId: string, toolName: string, success: boolean, rawResults?: unknown[], errorOutput?: string) => void
  onDelta: (text: string) => void
  onReasoningStarted: (itemId?: string) => void
  onReasoningDelta: (text: string) => void
  onReasoningCompleted: (itemId?: string, summary?: string[]) => void
  onTurnStarted: (turnId?: string) => void
  onWebSearchCall?: (phase: 'started' | 'searching' | 'completed' | 'failed', results?: unknown[]) => void
  getProviderTurnId: () => string | null
  setProviderTurnId: (id: string) => void
}

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

  constructor(adapter: ModelAdapter, toolRegistry: ToolRegistry, toolExclude?: string[]) {
    this.adapter = adapter
    this.toolRegistry = toolRegistry
    this.toolExclude = toolExclude ?? []
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
    const executedQueries = new Set<string>()

    let messages: CanonicalMessage[] = initialRequest.messages.slice()
    let round = 0

    while (round <= MAX_TOOL_ROUNDS) {
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
            callbacks.onWebSearchCall?.(event.phase, event.results)
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

      // 执行工具调用
      const toolResults = await this.executeTools(
        toolCalls,
        searchCallCount,
        fetchCallCount,
        executedQueries,
        signal,
        callbacks,
        toolCallHistory
      )
      totalToolCalls += toolCalls.length

      if (signal.aborted) break

      // 构建下一轮 messages：追加 assistant tool_calls 和 tool results
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

      // 已达最大轮数：追加提示消息强制模型输出最终回答，不依赖 tool_choice:'none'（部分模型忽略此参数）
      if (round >= MAX_TOOL_ROUNDS) {
        console.log('[ToolLoop] Reached MAX_TOOL_ROUNDS, sending wrap-up request')
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
    executedQueries: Set<string>,
    signal: AbortSignal,
    callbacks: ToolLoopCallbacks,
    toolCallHistory: ToolCallHistoryEntry[]
  ): Promise<CanonicalToolResult[]> {
    const toolResults: CanonicalToolResult[] = []

    for (const tc of toolCalls) {
      if (tc.name === 'openchat_web_search') {
        searchCallCount++
        if (searchCallCount > MAX_WEB_SEARCH_CALLS_PER_TURN) {
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
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.arguments) as Record<string, unknown>
      } catch {
        // 参数解析失败
      }

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
        const result = await executor.execute(args, { signal, conversationId: '', segmentId: '' })
        result.callId = tc.id
        result.name = tc.name
        toolResults.push(result)

        console.log('[Tool Result] name=', tc.name, '| output length=', result.output.length)

        let rawResults: unknown[] = []
        try {
          const parsed = JSON.parse(result.output) as Record<string, unknown>
          if (Array.isArray(parsed.results)) {
            rawResults = parsed.results
          } else if (parsed.url && typeof parsed.url === 'string') {
            // web_fetch result: fabricate a single-item results array for UI
            rawResults = [{ url: parsed.url, title: (parsed.title as string) || (parsed.url as string), snippet: ((parsed.content as string) || '').slice(0, 150) }]
          }
        } catch {
          // not JSON
        }

        toolCallHistory.push({
          callId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          output: result.output,
          rawResults,
          isError: result.isError ?? false,
        })

        callbacks.onToolResult(tc.id, tc.name, !result.isError, rawResults)
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