import type { ChatGPTCodexClient, ProviderInputItem, ResponsesSSEEvent } from '../transport/ChatGPTCodexClient'
import type { SearchCommands } from '../../../../shared/types/webSearch'
import { WebSearchToolExecutor } from './WebSearchToolExecutor'

const MAX_TOOL_ROUNDS = 6

export interface ToolCallItem {
  callId: string
  namespace: string
  name: string
  arguments: string
}

export interface ToolLoopCallbacks {
  onToolCall: (toolCall: ToolCallItem) => void
  onToolResult: (callId: string, success: boolean, rawResults?: unknown[]) => void
  onDelta: (text: string) => void
  onReasoningStarted: (itemId: string) => void
  onReasoningCompleted: (itemId: string, encryptedContent?: string) => void
  onTurnStarted: (turnId: string) => void
  onItemStarted: (itemId: string, itemType: string) => void
  onItemCompleted: (itemId: string, itemType: string) => void
  getProviderTurnId: () => string | null
  setProviderTurnId: (id: string) => void
}

export interface ToolLoopResult {
  finalText: string
  providerTurnId: string | null
  totalToolCalls: number
  toolCallHistory: Array<{
    callId: string
    args: SearchCommands
    output: string
    rawResults: unknown[]
    encryptedOutput?: string
  }>
}

export class ToolLoopController {
  private codexClient: ChatGPTCodexClient
  private searchExecutor: WebSearchToolExecutor

  constructor(codexClient: ChatGPTCodexClient, searchExecutor: WebSearchToolExecutor) {
    this.codexClient = codexClient
    this.searchExecutor = searchExecutor
  }

  async run(
    modelId: string,
    instructions: string,
    initialInput: ProviderInputItem[],
    effort: string,
    currentUserText: string,
    segmentId: string,
    signal: AbortSignal,
    callbacks: ToolLoopCallbacks
  ): Promise<ToolLoopResult> {
    const toolCallHistory: ToolLoopResult['toolCallHistory'] = []
    let totalToolCalls = 0
    let accumulatedContent = ''
    let providerTurnId: string | null = null

    let currentInput = initialInput.slice()

    // 发送请求
    const request = {
      model: modelId,
      instructions,
      input: currentInput,
      store: false,
      stream: true,
      ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
    }

    let events = this.codexClient.sendResponses(request, signal)

    let round = 0
    while (round <= MAX_TOOL_ROUNDS) {
      const toolCallsInRound: ToolCallItem[] = []
      let roundHasText = false

      for await (const event of events) {
        if (signal.aborted) break

        switch (event.type) {
          case 'response.created': {
            const id = this.extractId(event.response)
            if (id) {
              providerTurnId = id
              callbacks.setProviderTurnId(id)
              callbacks.onTurnStarted(id)
            }
            break
          }

          case 'response.output_item.added': {
            callbacks.onItemStarted(event.item.id, event.item.type)
            if (event.item.type === 'reasoning') {
              callbacks.onReasoningStarted(event.item.id)
            }
            break
          }

          case 'response.output_item.done': {
            if (event.item.type === 'function_call') {
              const fc: ToolCallItem = {
                callId: event.item.call_id ?? '',
                namespace: event.item.namespace ?? '',
                name: event.item.name ?? '',
                arguments: event.item.arguments ?? '',
              }
              if (fc.callId && fc.name === 'run') {
                toolCallsInRound.push(fc)
                callbacks.onToolCall(fc)
              }
            }
            if (event.item.type === 'reasoning') {
              callbacks.onReasoningCompleted(event.item.id, event.item.encrypted_content)
            }
            callbacks.onItemCompleted(event.item.id, event.item.type)
            break
          }

          case 'response.output_text.delta': {
            accumulatedContent += event.delta
            callbacks.onDelta(event.delta)
            roundHasText = true
            break
          }

          case 'response.output_text.done': {
            if (event.text) {
              accumulatedContent = event.text
            }
            break
          }

          case 'response.completed': {
            // 这一轮正常结束
            break
          }

          case 'error': {
            throw new Error(`Model error: ${event.code} - ${event.message}`)
          }
        }
      }

      if (signal.aborted) break

      // 没有工具调用，退出循环
      if (toolCallsInRound.length === 0) {
        break
      }

      // 已达最大轮数
      if (round >= MAX_TOOL_ROUNDS) {
        console.log('[ToolLoop] Reached MAX_TOOL_ROUNDS, stopping')
        break
      }

      round++

      // 执行每个工具调用（第一版串行）
      const toolResults: Array<{ callId: string; output: string }> = []

      for (const fc of toolCallsInRound) {
        totalToolCalls++

        let commands: SearchCommands
        try {
          commands = JSON.parse(fc.arguments) as SearchCommands
        } catch {
          console.error('[ToolLoop] Invalid JSON arguments:', fc.arguments.slice(0, 200))
          callbacks.onToolResult(fc.callId, false)
          toolResults.push({ callId: fc.callId, output: 'Error: Invalid arguments' })
          continue
        }

        console.log('[WebTool Call]', JSON.stringify(fc).slice(0, 300))

        try {
          const result = await this.searchExecutor.execute(
            fc.callId,
            commands,
            modelId,
            segmentId,
            currentUserText,
            signal
          )

          console.log('[WebTool Output] call:', fc.callId, '| output (truncated):', result.output.slice(0, 200))

          toolCallHistory.push({
            callId: fc.callId,
            args: commands,
            output: result.output,
            rawResults: result.rawResults,
            encryptedOutput: result.encryptedOutput,
          })

          toolResults.push({ callId: fc.callId, output: result.output })
          callbacks.onToolResult(fc.callId, true, result.rawResults)
        } catch (err) {
          console.error('[WebTool Error]', err instanceof Error ? err.message : String(err))
          callbacks.onToolResult(fc.callId, false)
          toolResults.push({
            callId: fc.callId,
            output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }

      if (signal.aborted) break

      // 构建下一轮 input：移除 additional_tools（仅首轮需要），追加 function_call 和 function_call_output
      currentInput = currentInput.filter((item) => !('type' in item && item.type === 'additional_tools'))
      for (const fc of toolCallsInRound) {
        currentInput.push({
          type: 'function_call',
          call_id: fc.callId,
          ...(fc.namespace ? { namespace: fc.namespace } : {}),
          name: fc.name,
          arguments: fc.arguments,
        })
      }
      for (const tr of toolResults) {
        currentInput.push({
          type: 'function_call_output',
          call_id: tr.callId,
          output: tr.output,
        })
      }

      // 发送下一轮请求
      const continuationRequest = {
        model: modelId,
        instructions,
        input: currentInput,
        store: false,
        stream: true,
        ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
      }
      events = this.codexClient.sendResponses(continuationRequest, signal)
    }

    return {
      finalText: accumulatedContent,
      providerTurnId,
      totalToolCalls,
      toolCallHistory,
    }
  }

  private extractId(response: unknown): string {
    if (response && typeof response === 'object' && 'id' in response) {
      return String((response as { id: unknown }).id)
    }
    return ''
  }
}