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
  }>
  tool_choice?: 'auto' | 'none' | 'required'
  reasoning?: { effort: string }
  max_output_tokens?: number
  temperature?: number
}

interface PendingFunctionCall {
  // 关联键：优先 item_id（output_item.added 的 item.id 与 function_call_arguments.* 的 item_id 一致）
  key: string
  itemId: string
  outputIndex: number
  callId: string
  name: string
  arguments: string
}

export class ResponsesAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'responses'
  readonly capabilities: { toolCalling: boolean; reasoning: boolean }

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
    this.capabilities = { toolCalling: config.toolCalling, reasoning: config.supportsReasoning ?? false }
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

    // 脱敏调试日志：打印最终发送的请求体
    console.log('[Responses Request] protocol=responses')
    console.log('[Responses Request] endpoint=', url)
    console.log('[Responses Request] model=', body.model)
    console.log('[Responses Request] toolChoice=', body.tool_choice ?? 'none')
    console.log('[Responses Request] tools=', JSON.stringify(body.tools ?? []))
    console.log('[Responses Request] reasoning=', body.reasoning ? JSON.stringify(body.reasoning) : 'none')
    console.log('[Responses Request] inputTypes=', body.input.map((item) => item.type))

    // SSE 事件类型统计（仅用于诊断）
    const seenEventTypes = new Set<string>()
    let structuredFunctionCallReceived = false
    let textualToolMarkup = false

    // 推理阶段追踪
    let reasoningActive = false
    let reasoningAccum = ''

    // Function Call 追踪（按 item_id 索引，从 output_item.added 开始，到 output_item.done 最终 emit）
    const pendingFunctionCalls = new Map<string, PendingFunctionCall>()
    const emittedCallIds = new Set<string>()

    const finalizeAndEmit = (pending: PendingFunctionCall): CanonicalToolCall | null => {
      if (!pending.callId || !pending.name) return null
      if (emittedCallIds.has(pending.callId)) return null
      emittedCallIds.add(pending.callId)
      structuredFunctionCallReceived = true
      return { id: pending.callId, name: pending.name, arguments: pending.arguments }
    }

    for await (const event of this.streamRequest(url, body, signal)) {
      if (event === '[DONE]') return

      try {
        const parsed = JSON.parse(event) as { type?: string; [key: string]: unknown }
        const eventType = parsed.type ?? 'unknown'
        seenEventTypes.add(eventType)

        switch (eventType) {

          // ====== Turn Lifecycle ======
          case 'response.created': {
            const id = (parsed.response as { id?: string })?.id
            if (id) yield { type: 'turn_started', turnId: id }
            break
          }

          case 'response.completed': {
            // 补发未完成的推理
            if (reasoningActive) {
              reasoningActive = false
              const summary = reasoningAccum
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0)
              yield { type: 'reasoning_completed', summary: summary.length > 0 ? summary : (reasoningAccum.trim() ? [reasoningAccum.trim()] : []) }
              reasoningAccum = ''
            }

            // 从 response.output 兜底提取未 emit 的 function_call（部分 provider 不发 output_item.done）
            const response = parsed.response as { output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string; id?: string }> } | undefined
            if (response?.output) {
              for (const item of response.output) {
                if (item.type !== 'function_call') continue
                // 通过 call_id 反查已 pending 的调用
                const callId = item.call_id ?? ''
                let existing: PendingFunctionCall | undefined
                for (const [, p] of pendingFunctionCalls) {
                  if (callId && p.callId === callId) {
                    existing = p
                    break
                  }
                }
                if (!existing) {
                  existing = {
                    key: item.id ?? callId ?? `idx_${pendingFunctionCalls.size}`,
                    itemId: item.id ?? '',
                    outputIndex: pendingFunctionCalls.size,
                    callId: '',
                    name: '',
                    arguments: '',
                  }
                }
                if (item.call_id) existing.callId = item.call_id
                if (item.name) existing.name = item.name
                if (item.arguments) existing.arguments = item.arguments

                const tc = finalizeAndEmit(existing)
                if (tc) {
                  console.log('[Responses Tool] finalized (from completed.output):', JSON.stringify(tc))
                  yield { type: 'tool_call', callId: tc.id, name: tc.name, arguments: tc.arguments }
                }
              }
            }

            // 诊断汇总
            console.log('[Responses SSE Event Types]', Array.from(seenEventTypes).join(', '))
            console.log('[Responses Diagnostics] structuredFunctionCall=', structuredFunctionCallReceived, 'textualToolMarkup=', textualToolMarkup)

            yield { type: 'turn_completed' }
            break
          }

          // ====== Output Text (visible content only) ======
          case 'response.output_text.delta': {
            const delta = parsed.delta as string
            if (delta) {
              // 检测是否包含 <tool_call> 纯文本标记
              if (!textualToolMarkup && /<tool_call>/i.test(delta)) {
                textualToolMarkup = true
              }
              yield { type: 'delta', text: delta }
            }
            break
          }

          // ====== Reasoning (strictly separated from visible text) ======
          case 'response.reasoning_text.delta': {
            const delta = parsed.delta as string
            if (!delta) break
            if (!reasoningActive) {
              reasoningActive = true
              yield { type: 'reasoning_started', itemId: parsed.item_id as string }
            }
            reasoningAccum += delta
            yield { type: 'reasoning_delta', text: delta }
            break
          }

          case 'response.reasoning_summary_text.delta': {
            const delta = parsed.delta as string
            if (!delta) break
            if (!reasoningActive) {
              reasoningActive = true
              yield { type: 'reasoning_started', itemId: parsed.item_id as string }
            }
            reasoningAccum += delta
            yield { type: 'reasoning_delta', text: delta }
            break
          }

          case 'response.reasoning_text.done':
          case 'response.reasoning_summary_text.done': {
            const itemId = parsed.item_id as string
            reasoningActive = false
            const summary = reasoningAccum
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0)
            yield { type: 'reasoning_completed', itemId, summary: summary.length > 0 ? summary : (reasoningAccum.trim() ? [reasoningAccum.trim()] : []) }
            reasoningAccum = ''
            break
          }

          // ====== Response Output Item Lifecycle ======
          case 'response.output_item.added': {
            const item = parsed.item as { type?: string; call_id?: string; name?: string; arguments?: string; id?: string }
            if (item?.type === 'function_call') {
              const key = item.id ?? `idx_${parsed.output_index ?? pendingFunctionCalls.size}`
              pendingFunctionCalls.set(key, {
                key,
                itemId: item.id ?? '',
                outputIndex: (parsed.output_index as number) ?? pendingFunctionCalls.size,
                callId: item.call_id ?? '',
                name: item.name ?? '',
                arguments: item.arguments ?? '',
              })
            }
            break
          }

          // ====== Function Call Argument Deltas ======
          case 'response.function_call_arguments.delta': {
            const key = (parsed.item_id as string) ?? ''
            const delta = parsed.delta as string
            if (key && delta) {
              const existing = pendingFunctionCalls.get(key)
              if (existing) {
                existing.arguments += delta
              } else {
                pendingFunctionCalls.set(key, {
                  key,
                  itemId: key,
                  outputIndex: (parsed.output_index as number) ?? pendingFunctionCalls.size,
                  callId: '',
                  name: '',
                  arguments: delta,
                })
              }
            }
            break
          }

          case 'response.function_call_arguments.done': {
            const key = (parsed.item_id as string) ?? ''
            if (key) {
              const existing = pendingFunctionCalls.get(key)
              if (existing) {
                if (parsed.name) existing.name = parsed.name as string
                if (parsed.arguments) existing.arguments = parsed.arguments as string
                if (parsed.call_id) existing.callId = parsed.call_id as string
              } else {
                pendingFunctionCalls.set(key, {
                  key,
                  itemId: key,
                  outputIndex: (parsed.output_index as number) ?? pendingFunctionCalls.size,
                  callId: (parsed.call_id as string) ?? '',
                  name: (parsed.name as string) ?? '',
                  arguments: (parsed.arguments as string) ?? '',
                })
              }
            }
            break
          }

          // ====== Output Item Done (authoritative final call — emit ONCE per call_id) ======
          case 'response.output_item.done': {
            const item = parsed.item as { type?: string; call_id?: string; name?: string; arguments?: string; id?: string }

            if (item?.type === 'reasoning') {
              reasoningActive = false
              const summary = reasoningAccum
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0)
              yield { type: 'reasoning_completed', itemId: item.id, summary: summary.length > 0 ? summary : (reasoningAccum.trim() ? [reasoningAccum.trim()] : []) }
              reasoningAccum = ''
            }

            if (item?.type === 'function_call') {
              const key = item.id ?? `idx_${parsed.output_index ?? ''}`
              // 查找已有 pending，或创建新的
              let existing = pendingFunctionCalls.get(key)
              if (!existing) {
                // 尝试通过 call_id 反查（某些 provider 可能 item.id 变了但 call_id 不变）
                const callId = item.call_id ?? ''
                for (const [, p] of pendingFunctionCalls) {
                  if (callId && p.callId === callId) {
                    existing = p
                    break
                  }
                }
              }
              if (!existing) {
                existing = {
                  key,
                  itemId: item.id ?? '',
                  outputIndex: (parsed.output_index as number) ?? pendingFunctionCalls.size,
                  callId: '',
                  name: '',
                  arguments: '',
                }
                pendingFunctionCalls.set(key, existing)
              }

              // output_item.done 是权威最终数据，直接覆盖
              if (item.call_id) existing.callId = item.call_id
              if (item.name) existing.name = item.name
              if (item.arguments) existing.arguments = item.arguments

              const tc = finalizeAndEmit(existing)
              if (tc) {
                console.log('[Responses Tool] finalized tool call:', JSON.stringify(tc))
                yield { type: 'tool_call', callId: tc.id, name: tc.name, arguments: tc.arguments }
              }
            }
            break
          }

          // ====== Error ======
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