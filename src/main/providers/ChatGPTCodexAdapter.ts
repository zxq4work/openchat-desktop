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

export class ChatGPTCodexAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'chatgpt_codex'
  readonly supportsToolCalling = true
  readonly supportsReasoning = true

  private codexClient: ChatGPTCodexClient

  constructor(codexClient: ChatGPTCodexClient) {
    this.codexClient = codexClient
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
    reasoning?: { effort: string; summary: string }
  } {
    const input: ProviderInputItem[] = []

    // 添加工具声明
    if (request.tools && request.tools.length > 0) {
      input.unshift({
        type: 'additional_tools',
        role: 'developer',
        tools: request.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
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
      reasoning?: { effort: string; summary: string }
    } = {
      model: request.model,
      instructions: request.systemPrompt ?? '',
      input,
      store: false,
      stream: true,
    }

    if (request.reasoningEffort) {
      req.reasoning = { effort: request.reasoningEffort, summary: 'auto' }
    }

    return req
  }

  private convertMessages(msg: CanonicalMessage): ProviderInputItem[] {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      return msg.toolCalls.map((tc) => ({
        type: 'function_call',
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }))
    }

    if (msg.toolResult) {
      return [{
        type: 'function_call_output',
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
            arguments: event.item.arguments ?? '',
          }
        }
        return null

      case 'response.completed':
        return { type: 'turn_completed' }

      case 'error':
        return { type: 'error', code: event.code, message: event.message }

      default:
        return null
    }
  }
}