import type { IncomingMessage } from 'http'
import * as fs from 'fs'
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
import { createRequest } from '../openai/chatgpt/httpsClient'
import { UnsupportedImageInputError } from './errors'

type ChatCompletionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

interface ChatCompletionMessage {
  role: string
  content: string | ChatCompletionContentPart[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
  tool_call_id?: string
  name?: string
}

interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ChatCompletionRequest {
  model: string
  messages: ChatCompletionMessage[]
  stream: boolean
  tools?: ChatCompletionTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  reasoning_effort?: string
  max_tokens?: number
  temperature?: number
}

export class ChatCompletionsAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'chat_completions'
  readonly capabilities: { toolCalling: boolean; reasoning: boolean; supportsImageInput: boolean }

  private baseUrl: string
  private apiKey: string
  private chatCompletionsPath: string
  private extraHeaders: Record<string, string>

  constructor(config: {
    baseUrl: string
    apiKey: string
    toolCalling: boolean
    chatCompletionsPath?: string
    extraHeaders?: Record<string, string>
    supportsReasoning?: boolean
    imageInput?: boolean
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.capabilities = {
      toolCalling: config.toolCalling,
      reasoning: config.supportsReasoning ?? false,
      supportsImageInput: config.imageInput ?? false,
    }
    // 如果 baseUrl 已以 /v1 结尾，则使用短路径，否则用完整路径
    if (config.chatCompletionsPath) {
      this.chatCompletionsPath = config.chatCompletionsPath
    } else if (this.baseUrl.endsWith('/v1')) {
      this.chatCompletionsPath = '/chat/completions'
    } else {
      this.chatCompletionsPath = '/v1/chat/completions'
    }
    this.extraHeaders = config.extraHeaders || {}
  }

  async *stream(
    request: CanonicalModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalModelEvent> {
    const body = this.buildRequest(request)
    const url = `${this.baseUrl}${this.chatCompletionsPath}`

    console.log('[Model Request] protocol=chat_completions model=', request.model)

    // 收集工具调用（跨 delta 累积）
    const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>()
    // 推理内容累积（deepseek 等模型通过 reasoning_content 字段流式返回思考过程）
    let reasoningAccum = ''
    let reasoningActive = false

    for await (const event of this.streamRequest(url, body, signal)) {
      if (event === '[DONE]') break

      try {
        const parsed = JSON.parse(event) as {
          choices?: Array<{
            index?: number
            delta?: {
              content?: string
              reasoning_content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string
          }>
        }

        for (const choice of parsed.choices ?? []) {
          const delta = choice.delta
          if (!delta) continue

          // 推理内容（思考过程），与回答文本分离
          if (delta.reasoning_content) {
            if (!reasoningActive) {
              reasoningActive = true
              yield { type: 'reasoning_started' }
            }
            reasoningAccum += delta.reasoning_content
            yield { type: 'reasoning_delta', text: delta.reasoning_content }
          }

          // 回答文本增量：出现时若仍在思考阶段，先结束思考
          if (delta.content) {
            if (reasoningActive) {
              reasoningActive = false
              yield { type: 'reasoning_completed', summary: this.splitReasoning(reasoningAccum) }
              reasoningAccum = ''
            }
            yield { type: 'delta', text: delta.content }
          }

          // 工具调用增量
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallAccumulators.get(tc.index) ?? {
                id: '',
                name: '',
                arguments: '',
              }
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.arguments += tc.function.arguments
              toolCallAccumulators.set(tc.index, existing)
            }
          }

          // finish_reason = tool_calls → 发出完整的 tool calls
          if (choice.finish_reason === 'tool_calls') {
            if (reasoningActive) {
              reasoningActive = false
              yield { type: 'reasoning_completed', summary: this.splitReasoning(reasoningAccum) }
              reasoningAccum = ''
            }
            for (const [, tc] of toolCallAccumulators) {
              if (tc.id && tc.name) {
                yield { type: 'tool_call', callId: tc.id, name: tc.name, arguments: tc.arguments }
              }
            }
            toolCallAccumulators.clear()
          }
        }
      } catch {
        // 跳过无法解析的 SSE 数据
      }
    }

    // 流结束：若仍在思考阶段，补发 reasoning_completed
    if (reasoningActive) {
      reasoningActive = false
      yield { type: 'reasoning_completed', summary: this.splitReasoning(reasoningAccum) }
      reasoningAccum = ''
    }

    // 流结束，check 未发出的 tool calls
    for (const [, tc] of toolCallAccumulators) {
      if (tc.id && tc.name) {
        yield { type: 'tool_call', callId: tc.id, name: tc.name, arguments: tc.arguments }
      }
    }

    // 标记流结束（缺失会导致上层一直处于“生成中”）
    yield { type: 'turn_completed' }
  }

  // 读取受管图片文件并编码为 base64 data URL。读取失败返回 null（调用方须显式失败，不得降级）。
  private readImageDataUrl(storagePath: string, mimeType: string): string | null {
    try {
      const buffer = fs.readFileSync(storagePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      // 不打印本地路径，避免文件系统信息进入日志
      console.error('[ChatCompletionsAdapter] failed to read image attachment')
      return null
    }
  }

  // 将累积的思考文本按行拆分为摘要数组，便于前端按段落展示
  private splitReasoning(text: string): string[] {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    return lines.length > 0 ? lines : (text.trim() ? [text.trim()] : [])
  }

  private buildRequest(request: CanonicalModelRequest): ChatCompletionRequest {
    const messages: ChatCompletionMessage[] = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }

    for (const msg of request.messages) {
      messages.push(this.convertMessage(msg, request))
    }

    const body: ChatCompletionRequest = {
      model: request.model,
      messages,
      stream: true,
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(this.convertTool)
      body.tool_choice = request.toolChoice ?? 'auto'
    } else if (request.toolChoice === 'none') {
      body.tool_choice = 'none'
    }

    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort
    }

    if (request.maxOutputTokens) {
      body.max_tokens = request.maxOutputTokens
    }

    if (request.temperature != null) {
      body.temperature = request.temperature
    }

    return body
  }

  private convertMessage(msg: CanonicalMessage, request: CanonicalModelRequest): ChatCompletionMessage {
    const ccMsg: ChatCompletionMessage = {
      role: msg.role === 'developer' ? 'system' : msg.role,
      content: msg.content ?? null,
    }

    // 多模态内容：user 消息带 inputParts 时构建 OpenAI 兼容的 multipart content。
    // 图片字节由主进程 resolver 读取并编码为 base64 data URL；任何图片无法编码时
    // 必须显式失败，绝不静默降级为纯文本（否则用户会误以为模型看到了图片）。
    if (msg.inputParts && msg.inputParts.length > 0) {
      const parts: ChatCompletionContentPart[] = []
      for (const part of msg.inputParts) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text })
        } else if (part.type === 'image') {
          // 最后一层 defensive check：capability gate 已提前拦截。
          if (!this.capabilities.supportsImageInput) {
            throw new UnsupportedImageInputError()
          }
          const resolved = request.attachmentResolver?.resolveForProvider(part.attachmentId)
          if (!resolved) {
            throw new UnsupportedImageInputError('图片附件无法解析')
          }
          const encoded = this.readImageDataUrl(resolved.storagePath, resolved.mimeType)
          if (!encoded) {
            throw new UnsupportedImageInputError('图片文件读取失败')
          }
          parts.push({ type: 'image_url', image_url: { url: encoded, detail: part.detail ?? resolved.detail ?? 'auto' } })
        }
      }
      if (parts.length > 0) {
        ccMsg.content = parts
      }
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      ccMsg.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }))
    }

    if (msg.toolResult) {
      ccMsg.role = 'tool'
      ccMsg.tool_call_id = msg.toolResult.callId
      ccMsg.content = msg.toolResult.output
    }

    return ccMsg
  }

  private convertTool(tool: OpenChatToolDefinition): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }
  }

  private async *streamRequest(
    url: string,
    body: ChatCompletionRequest,
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
      const defaultPort = isHttps ? 443 : 80
      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : defaultPort,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          protocol: isHttps ? 'https:' : 'http:',
          bypassLocal: true,
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
      if (notify) {
        const n = notify; notify = null; n()
      }
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