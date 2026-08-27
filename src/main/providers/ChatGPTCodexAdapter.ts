import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  CanonicalMessage,
  ProviderProtocol,
} from '../../shared/types/provider'
import type {
  ChatGPTCodexClient,
  ProviderInputItem,
  ResponsesSSEEvent,
} from '../openai/chatgpt/transport/ChatGPTCodexClient'

export interface CodexRequestOptions {
  useResponsesLite?: boolean
}

export class ChatGPTCodexAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'chatgpt_codex'
  readonly capabilities = { toolCalling: true, reasoning: true }

  private codexClient: ChatGPTCodexClient
  private useResponsesLite: boolean

  constructor(codexClient: ChatGPTCodexClient, useResponsesLite = false) {
    this.codexClient = codexClient
    this.useResponsesLite = useResponsesLite
  }

  setUseResponsesLite(v: boolean): void {
    this.useResponsesLite = v
  }

  getUseResponsesLite(): boolean {
    return this.useResponsesLite
  }

  async *stream(
    request: CanonicalModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalModelEvent> {
    const responsesRequest = this.buildRequest(request)

    let turnId = ''

    for await (const event of this.codexClient.sendResponses(responsesRequest, signal)) {
      const canonical = this.convertEvent(event)
      if (canonical) {
        if (canonical.type === 'turn_started' && canonical.turnId) {
          turnId = canonical.turnId
        }
        yield canonical
      }
    }
  }

  private buildRequest(request: CanonicalModelRequest): {
    model: string
    instructions: string
    input: ProviderInputItem[]
    store: boolean
    stream: boolean
    reasoning?: { effort: string; summary: string; context?: string }
    useResponsesLite?: boolean
    tools?: unknown[]
    include?: string[]
    toolChoice?: string | { type: string }
  } {
    const input: ProviderInputItem[] = []

    // 分离 hosted 工具（如官方 web_search）与 client 工具（function）
    // hosted 工具放到顶层 tools，client 工具放到 additional_tools
    const hostedTools: unknown[] = []
    const clientTools: unknown[] = []

    for (const t of request.tools ?? []) {
      if (t.toolType === 'web_search') {
        // Codex 官方 Hosted Web Search：服务端执行搜索，无需 function 声明
        hostedTools.push({
          type: 'web_search',
          search_context_size: 'high',
        })
      } else {
        clientTools.push({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })
      }
    }

    // hosted 工具放入顶层 tools（区别于 additional_tools）
    if (clientTools.length > 0) {
      input.unshift({
        type: 'additional_tools',
        role: 'developer',
        tools: clientTools,
      })
    }

    for (const msg of request.messages) {
      input.push(...this.convertMessages(msg))
    }

    const req: {
      model: string
      instructions: string
      input: ProviderInputItem[]
      store: boolean
      stream: boolean
      reasoning?: { effort: string; summary: string; context?: string }
      useResponsesLite?: boolean
      tools?: unknown[]
      include?: string[]
      toolChoice?: string | { type: string }
    } = {
      model: request.model,
      instructions: request.systemPrompt ?? '',
      input,
      store: false,
      stream: true,
      useResponsesLite: this.useResponsesLite || undefined,
    }

    // hosted 工具：顶层 tools + include 请求来源 URL
    if (hostedTools.length > 0) {
      req.tools = hostedTools
      req.include = ['web_search_call.action.sources']
    }

    // tool_choice 映射：'required' 且存在 hosted web_search 时，强制 web_search
    if (request.toolChoice) {
      if (request.toolChoice === 'required' && hostedTools.length > 0) {
        req.toolChoice = { type: 'web_search' }
      } else if (request.toolChoice === 'none') {
        req.toolChoice = 'none'
      } else {
        req.toolChoice = 'auto'
      }
    }

    if (request.reasoningEffort) {
      const reasoning: { effort: string; summary: string; context?: string } = {
        effort: request.reasoningEffort,
        summary: 'auto',
      }
      // Responses Lite 要求 reasoning.context 为 all_turns
      if (this.useResponsesLite) {
        reasoning.context = 'all_turns'
      }
      req.reasoning = reasoning
    }

    return req
  }

  private convertMessages(msg: CanonicalMessage): ProviderInputItem[] {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      return msg.toolCalls.map((tc) => ({
        type: 'function_call' as const,
        call_id: tc.id,
        name: tc.name,
        namespace: tc.namespace,
        arguments: tc.arguments,
      }))
    }

    if (msg.toolResult) {
      return [{
        type: 'function_call_output' as const,
        call_id: msg.toolResult.callId,
        output: msg.toolResult.output,
      }]
    }

    return [{
      role: msg.role === 'developer' ? 'developer' : msg.role,
      content: msg.content ?? '',
    }]
  }

  private convertEvent(event: ResponsesSSEEvent): CanonicalModelEvent | null {
    switch (event.type) {
      case 'response.created':
        return {
          type: 'turn_started',
          turnId: (event.response as { id?: string })?.id ?? '',
        }

      case 'response.output_text.delta':
        return { type: 'delta', text: event.delta }

      case 'response.output_item.added':
        if (event.item.type === 'reasoning') {
          return { type: 'reasoning_started', itemId: event.item.id }
        }
        return null

      case 'response.output_item.done':
        if (event.item.type === 'message') {
          // 最终 assistant message 完成：打印 citation annotations 诊断（不打印完整回答）
          const annotations = event.item.annotations
          if (Array.isArray(annotations) && annotations.length > 0) {
            console.log('[Codex Adapter] output_item.done message annotations count=', annotations.length)
            annotations.forEach((a, i) => {
              const ann = a as Record<string, unknown>
              const annType = ann.type ?? '(no type)'
              const keys = Object.keys(ann)
              console.log(`[Codex Adapter]   annotation[${i}] type=${annType} keys=${keys.join(',')} url=${ann.url ?? '(none)'} title=${ann.title ?? '(none)'}`)
            })
          } else {
            console.log('[Codex Adapter] output_item.done message annotations count=0 (none)')
          }
        }
        if (event.item.type === 'reasoning') {
          const summary = (event.item.summary ?? [])
            .filter((s) => s.type === 'summary_text' && typeof s.text === 'string')
            .map((s) => s.text)
          return { type: 'reasoning_completed', itemId: event.item.id, summary }
        }
        if (event.item.type === 'function_call') {
          return {
            type: 'tool_call',
            callId: event.item.call_id ?? '',
            name: event.item.name ?? '',
            namespace: (event.item as { namespace?: string }).namespace,
            arguments: event.item.arguments ?? '',
          }
        }
        // hosted web_search 结果：item.type === 'web_search_call'，含 action.sources
        if (event.item.type === 'web_search_call') {
          const item = event.item as { type: string; id: string; action?: { sources?: Array<{ url?: string; title?: string; type?: string }> } }
          const sources = item.action?.sources ?? []
          console.log('[Codex Adapter] output_item.done web_search_call sourcesCount=', sources.length)
          if (sources.length > 0) {
            const firstSource = sources[0]
            const keys = Object.keys(firstSource as Record<string, unknown>)
            console.log('[Codex Adapter] output_item.done firstSource keys=', keys.join(','), 'title=', (firstSource as Record<string, unknown>).title ?? '(none)', 'url=', (firstSource as Record<string, unknown>).url ?? '(none)')
          }
          return {
            type: 'web_search_call',
            phase: 'completed',
            results: sources,
          }
        }
        return null

      case 'response.web_search_call.started':
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        console.log('[Codex Adapter] web_search_call phase=started eventType=', event.type)
        return { type: 'web_search_call', phase: 'started' }

      case 'response.web_search_call.completed':
        {
          const responseResults = (event.response as { results?: unknown[] } | undefined)?.results
          if (responseResults && responseResults.length > 0) {
            console.log('[Codex Adapter] web_search_call phase=completed resultsCount=', responseResults.length)
            const first = responseResults[0]
            if (first && typeof first === 'object') {
              const keys = Object.keys(first as Record<string, unknown>)
              console.log('[Codex Adapter] web_search_call firstResult keys=', keys.join(','))
            }
          } else {
            console.log('[Codex Adapter] web_search_call phase=completed resultsCount=0 (results may come via output_item.done)')
          }
        }
        // 不在此处发射 completed，避免与 output_item.done (web_search_call) 重复
        // 此事件仅作为搜索完成的信号，实际 sources 由 output_item.done 提供
        return { type: 'web_search_call', phase: 'searching' }

      case 'response.web_search_call.failed':
        console.log('[Codex Adapter] web_search_call phase=failed')
        return { type: 'web_search_call', phase: 'failed' }

      case 'response.completed':
        return { type: 'turn_completed' }

      case 'error':
        return { type: 'error', code: event.code, message: event.message }

      default:
        return null
    }
  }
}
