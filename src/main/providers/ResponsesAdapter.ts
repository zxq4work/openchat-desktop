import * as https from 'https'
import * as http from 'http'
import type { IncomingMessage } from 'http'
import { SSEParser } from './SSEParser'
import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  CanonicalMessage,
  OpenChatToolDefinition,
  CanonicalToolCall,
  ProviderProtocol,
} from '../../shared/types/provider'
import { getProxyAgentForHost } from '../openai/chatgpt/httpsClient'

interface ResponsesInputItem {
  type: string
  [key: string]: unknown
}

interface ResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  stream: boolean
  instructions?: string
  tools?: Array<{
    type: 'function'
    name: string
    description: string
    parameters: Record<string, unknown>
    strict: boolean
  }>
  tool_choice?: 'auto' | 'none' | 'required'
  reasoning?: { effort: string }
  max_output_tokens?: number
  temperature?: number
}

export class ResponsesAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'responses'
  readonly supportsToolCalling: boolean
  readonly supportsReasoning: boolean

  private baseUrl: string
  private apiKey: string
  private responsesPath: string
  private extraHeaders: Record<string, string>

  constructor(config: {
    baseUrl: string
    apiKey: string
    toolCalling: boolean
    responsesPath?: string
    extraHeaders?: Record<string, string>
    supportsReasoning?: boolean
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.supportsToolCalling = config.toolCalling
    this.supportsReasoning = config.supportsReasoning ?? false
    // 如果 baseUrl 已以 /v1 结尾，则使用短路径，否则用完整路径
    if (config.responsesPath) {
      this.responsesPath = config.responsesPath
    } else if (this.baseUrl.endsWith('/v1')) {
      this.responsesPath = '/responses'
    } else {
      this.responsesPath = '/v1/responses'
    }
    this.extraHeaders = config.extraHeaders || {}
  }

  async *stream(
    request: CanonicalModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalModelEvent> {
    const body = this.buildRequest(request)
    const url = `${this.baseUrl}${this.responsesPath}`

    console.log('[Model Request] protocol=responses')
    console.log('[Model Request] model=', request.model)
    console.log('[Model Request] tools=', body.tools?.length ?? 0)

    // 收集 function_call 参数增量
    const functionCallArgs = new Map<string, { name: string; arguments: string }>()
    // 记录 output_item.done 中的完整 function_call（以最终完整 item 为准）
    const completedCalls = new Map<string, CanonicalToolCall>()

    for await (const event of this.streamRequest(url, body, signal)) {
      if (event === '[DONE]') return

      try {
        const parsed = JSON.parse(event) as { type?: string; [key: string]: unknown }

        switch (parsed.type) {
          case 'response.created': {
            const id = (parsed.response as { id?: string })?.id
            if (id) yield { type: 'turn_started', turnId: id }
            break
          }

          case 'response.output_text.delta': {
            const delta = parsed.delta as string
            if (delta) yield { type: 'delta', text: delta }
            break
          }

          case 'response.reasoning_text.delta': {
            const delta = parsed.delta as string
            if (delta) yield { type: 'reasoning_started', itemId: parsed.item_id as string }
            break
          }

          case 'response.function_call_arguments.delta': {
            const itemId = parsed.item_id as string
            const delta = parsed.delta as string
            const existing = functionCallArgs.get(itemId) ?? { name: '', arguments: '' }
            existing.arguments += delta
            functionCallArgs.set(itemId, existing)
            break
          }

          case 'response.function_call_arguments.done': {
            const itemId = parsed.item_id as string
            const name = parsed.name as string
            const args = parsed.arguments as string
            functionCallArgs.set(itemId, { name, arguments: args })
            break
          }

          case 'response.output_item.done': {
            const item = parsed.item as { type?: string; call_id?: string; name?: string; arguments?: string }
            if (item?.type === 'function_call' && item.call_id) {
              completedCalls.set(item.call_id, {
                id: item.call_id,
                name: item.name ?? '',
                arguments: item.arguments ?? '',
              })
            }
            break
          }

          case 'response.completed': {
            // 发出所有已完成的 function calls
            for (const [, tc] of completedCalls) {
              if (tc.id && tc.name) {
                yield { type: 'tool_call', callId: tc.id, name: tc.name, arguments: tc.arguments }
              }
            }
            // 同时发出通过 delta 累积的 function calls
            for (const [itemId, acc] of functionCallArgs) {
              if (acc.name && !completedCalls.has(itemId)) {
                yield { type: 'tool_call', callId: itemId, name: acc.name, arguments: acc.arguments }
              }
            }
            yield { type: 'turn_completed' }
            break
          }

          case 'error': {
            yield {
              type: 'error',
              code: (parsed.code as string) ?? 'MODEL_UPSTREAM_ERROR',
              message: (parsed.message as string) ?? 'Model error',
            }
            break
          }
        }
      } catch {
        // 跳过无法解析的 SSE 数据
      }
    }
  }

  private buildRequest(request: CanonicalModelRequest): ResponsesRequest {
    const input: ResponsesInputItem[] = []

    for (const msg of request.messages) {
      input.push(this.convertMessage(msg))
    }

    const body: ResponsesRequest = {
      model: request.model,
      input,
      stream: true,
    }

    if (request.systemPrompt) {
      body.instructions = request.systemPrompt
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function' as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }))
      body.tool_choice = request.toolChoice ?? 'auto'
    } else if (request.toolChoice === 'none') {
      body.tool_choice = 'none'
    }

    if (request.reasoningEffort) {
      body.reasoning = { effort: request.reasoningEffort }
    }

    if (request.maxOutputTokens) {
      body.max_output_tokens = request.maxOutputTokens
    }

    if (request.temperature != null) {
      body.temperature = request.temperature
    }

    return body
  }

  private convertMessage(msg: CanonicalMessage): ResponsesInputItem {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const tc = msg.toolCalls[0]
      return {
        type: 'function_call',
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }
    }

    if (msg.toolResult) {
      return {
        type: 'function_call_output',
        call_id: msg.toolResult.callId,
        output: msg.toolResult.output,
      }
    }

    return {
      type: 'message',
      role: msg.role === 'developer' ? 'developer' : msg.role,
      content: [{ type: 'input_text', text: msg.content ?? '' }],
    }
  }

  private async *streamRequest(
    url: string,
    body: ResponsesRequest,
    signal?: AbortSignal
  ): AsyncIterable<string> {
    const parsed = new URL(url)
    const bodyStr = JSON.stringify(body)
    const bodyBytes = Buffer.byteLength(bodyStr)
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Content-Length': String(bodyBytes),
      ...this.extraHeaders,
    }

    const parser = new SSEParser()

    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const isHttps = parsed.protocol === 'https:'
      const lib = isHttps ? https : http
      const defaultPort = isHttps ? 443 : 80
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : defaultPort,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          agent: getProxyAgentForHost(parsed.hostname),
        },
        (res) => {
          if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res)
            return
          }

          let errBody = ''
          res.on('data', (chunk: Buffer) => { errBody += chunk.toString() })
          res.on('end', () => {
            reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`))
          })
        }
      )

      let abortHandler: (() => void) | null = null
      if (signal) {
        abortHandler = () => {
          req.destroy()
          reject(new Error('Aborted'))
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      req.on('error', (err) => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
        }
        reject(err)
      })
      req.write(bodyStr)
      req.end()
    })

    const chunks: Buffer[] = []
    let streamEnded = false
    let streamError: Error | null = null
    let notify: (() => void) | null = null

    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (notify) { const n = notify; notify = null; n() }
    })
    stream.on('end', () => { streamEnded = true; if (notify) { const n = notify; notify = null; n() } })
    stream.on('error', (err) => { streamError = err; streamEnded = true; if (notify) { const n = notify; notify = null; n() } })

    let chunkIdx = 0
    while (true) {
      while (chunkIdx >= chunks.length && !streamEnded) {
        await new Promise<void>((resolve) => { notify = resolve })
      }

      if (chunkIdx >= chunks.length && streamEnded) {
        if (streamError) throw streamError
        return
      }

      const chunk = chunks[chunkIdx++]
      const events = parser.parse(chunk.toString())
      for (const sseEvent of events) {
        if (sseEvent.data === '[DONE]') {
          yield '[DONE]'
          return
        }
        yield sseEvent.data
      }
    }
  }
}