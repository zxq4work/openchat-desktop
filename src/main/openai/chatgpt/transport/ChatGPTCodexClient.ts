import type { IncomingMessage } from 'http'
import { ResponsesStreamParser } from './ResponsesStreamParser'
import type { OAuthCredentialManager } from '../auth/OAuthCredentialManager'
import { createRequest } from '../httpsClient'
import { logNon2xxResponse } from '../rateLimitDiagnostics'

// ---- Error Types ----

export class UsageLimitReachedError extends Error {
  code: 'USAGE_LIMIT_REACHED' = 'USAGE_LIMIT_REACHED'
  resetsAt?: number
  planType?: string

  constructor(message: string, resetsAt?: number, planType?: string) {
    super(message)
    this.name = 'UsageLimitReachedError'
    this.resetsAt = resetsAt
    this.planType = planType
  }
}

// ---- Types ----

export interface ChatGPTModel {
  slug: string
  id: string
  display_name: string
  default_reasoning_level: string | { effort?: string; level?: string; reasoning_effort?: string; reasoning_level?: string; value?: string } | null
  supported_reasoning_levels: Array<string | { effort?: string; level?: string; reasoning_effort?: string; reasoning_level?: string; value?: string }>
  input_modalities: string[]
  supports_personality: boolean
  is_default: boolean
  base_instructions?: string
  use_responses_lite?: boolean
  web_search_tool_type?: string | null
  supports_search_tool?: boolean
  model_messages?: {
    instructions_template?: string
    instructions_variables?: unknown
  }
}

// Provider 输入项：支持普通消息、additional_tools 声明、
// function_call（模型工具调用）以及 function_call_output（工具回传结果）
export type ProviderInputItem =
  | { role: string; content: string }
  | { type: 'additional_tools'; role: string; tools: unknown[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; namespace?: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface ResponsesRequest {
  model: string
  instructions: string
  input: ProviderInputItem[]
  store?: boolean
  stream?: boolean
  reasoning?: { effort: string; summary?: string; context?: string }
  useResponsesLite?: boolean
  tools?: unknown[]
  include?: string[]
  toolChoice?: string | { type: string }
}

export interface ProviderFunctionCall {
  type: 'function_call'
  id?: string
  call_id: string
  namespace?: string
  name: string
  arguments: string
}

export type ResponsesSSEEvent =
  | { type: 'response.created'; response: unknown }
  | { type: 'response.output_item.added'; item: { type: string; id: string; name?: string; namespace?: string }; output_index: number }
  | { type: 'response.output_item.done'; item: { type: string; id: string; summary?: Array<{ type: string; text: string }>; encrypted_content?: string; name?: string; namespace?: string; call_id?: string; arguments?: string; action?: { sources?: Array<{ url?: string; title?: string; type?: string }> }; annotations?: unknown[] }; output_index: number }
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.output_text.done'; text: string }
  | { type: 'response.reasoning_text.delta'; delta: string }
  | { type: 'response.reasoning_text.done'; text: string }
  | { type: 'response.reasoning_summary_text.delta'; delta: string }
  | { type: 'response.reasoning_summary_text.done'; text: string }
  | { type: 'response.web_search_call.started'; response: unknown }
  | { type: 'response.web_search_call.in_progress'; response: unknown }
  | { type: 'response.web_search_call.searching'; response: unknown }
  | { type: 'response.web_search_call.completed'; response: unknown }
  | { type: 'response.web_search_call.failed'; response: unknown }
  | { type: 'response.completed'; response: unknown }
  | { type: 'error'; error: { code: string; message: string } }

// ---- Interface ----

export interface ChatGPTCodexClient {
  listModels(): Promise<ChatGPTModel[]>
  sendResponses(request: ResponsesRequest, signal?: AbortSignal): AsyncIterable<ResponsesSSEEvent>
}

// ---- Real Implementation ----

const BASE_URL = 'https://chatgpt.com'
const CLIENT_VERSION = '0.148.0'

export class RealChatGPTCodexClient implements ChatGPTCodexClient {
  private credentialManager: OAuthCredentialManager

  constructor(credentialManager: OAuthCredentialManager) {
    this.credentialManager = credentialManager
  }

  async listModels(): Promise<ChatGPTModel[]> {
    const token = await this.credentialManager.getAccessToken()
    const accountId = await this.credentialManager.getAccountId()

    const url = `${BASE_URL}/backend-api/codex/models?client_version=${CLIENT_VERSION}`

    const response = await this.fetchWithAuth(url, token, accountId)

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`)
    }

    const data = await response.json() as { models?: ChatGPTModel[] } | ChatGPTModel[]
    const models = Array.isArray(data) ? data : (data.models ?? [])
    if (models.length > 0) {
      console.log('[ChatGPTCodexClient] Models loaded:', models.length, 'first:', models[0].id, '|', models[0].display_name)
    }
    return models
  }

  async *sendResponses(request: ResponsesRequest, signal?: AbortSignal): AsyncIterable<ResponsesSSEEvent> {
    const token = await this.credentialManager.getAccessToken()
    const accountId = await this.credentialManager.getAccountId()

    const body = JSON.stringify({
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      store: false,
      stream: true,
      ...(request.useResponsesLite ? { parallel_tool_calls: false } : {}),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.include && request.include.length > 0 ? { include: request.include } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.reasoning ? { reasoning: { ...request.reasoning, summary: request.reasoning.summary ?? 'auto' } } : {}),
    })

    const parsedUrl = new URL(`${BASE_URL}/backend-api/codex/responses`)

    console.log('[ChatGPT Request]')
    console.log('endpoint=POST', parsedUrl.href)
    console.log('model=', request.model)
    console.log('instructions_length=', request.instructions.length)
    console.log('input_messages=', request.input.length)
    console.log('reasoning=', request.reasoning ?? 'none')
    if (request.tools && request.tools.length > 0) {
      console.log('[Codex Search] backend-hosted-search=true')
    } else {
      console.log('[Codex Search] backend-hosted-search=false (no tools, direct generation)')
    }
    if (request.useResponsesLite) {
      console.log('[Codex Responses] responsesLite=true')
    }

    const parser = new ResponsesStreamParser()
    const startTime = Date.now()

    let eventCount = 0
    const statusRef = { status: 0 }
    try {
      for await (const event of this.streamRequest(parsedUrl, token, accountId, body, parser, signal, statusRef, request.useResponsesLite)) {
        eventCount++
        yield event
      }
    } finally {
      const elapsed = Date.now() - startTime
      console.log('[ChatGPT Request] status=', statusRef.status)
      console.log('[ChatGPT API] Completed in', elapsed, 'ms, events:', eventCount)
    }
  }

  private async fetchWithAuth(url: string, token: string, accountId: string | null): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId
      }

      const req = createRequest(
        {
          hostname: parsedUrl.hostname,
          port: 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers,
          protocol: 'https:',
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            resolve({
              ok: res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode ?? 0,
              json: async () => JSON.parse(data),
            })
          })
        }
      )

      req.on('error', reject)
      req.end()
    })
  }

  private async *streamRequest(
    url: URL,
    token: string,
    accountId: string | null,
    body: string,
    parser: ResponsesStreamParser,
    signal?: AbortSignal,
    statusRef?: { status: number },
    useResponsesLite?: boolean
  ): AsyncIterable<ResponsesSSEEvent> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    }
    if (accountId) {
      headers['ChatGPT-Account-Id'] = accountId
    }
    if (useResponsesLite) {
      headers['x-openai-internal-codex-responses-lite'] = 'true'
    }

    let abortHandler: (() => void) | null = null

    try {
      const stream = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = createRequest(
          {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers,
            protocol: 'https:',
          },
          (res) => {
          if (statusRef) statusRef.status = res.statusCode ?? 0
          console.log('[ChatGPT Request] status=', res.statusCode)
          const endpoint = `POST ${url.hostname}${url.pathname}${url.search}`
          if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res)
            return
          }

          // 非 2xx：收集 body 后统一处理
          let body = ''
          res.on('data', (chunk: Buffer) => { body += chunk.toString() })
          res.on('end', () => {
            const msg = logNon2xxResponse(endpoint, 'POST', res.statusCode ?? 0, res.headers, body)
            if (res.statusCode === 401) {
              reject(new Error('Unauthorized: ' + body.slice(0, 200)))
            } else if (res.statusCode === 429) {
              // 检测是否为 usage_limit_reached（非临时限流）
              try {
                const parsed = JSON.parse(body) as { error?: { type?: string; message?: string; resets_at?: number; plan_type?: string } }
                if (parsed.error?.type === 'usage_limit_reached') {
                  reject(new UsageLimitReachedError(
                    parsed.error.message ?? 'Usage limit reached',
                    parsed.error.resets_at,
                    parsed.error.plan_type
                  ))
                  return
                }
              } catch {
                // 非 JSON body 或解析失败，当作普通 429
              }
              reject(new Error(msg))
            } else {
              reject(new Error(msg))
            }
          })
        })

        if (signal) {
          abortHandler = () => {
            req.destroy()
            reject(new Error('Aborted'))
          }
          signal.addEventListener('abort', abortHandler, { once: true })
        }

        req.on('error', reject)
        req.write(body)
        req.end()
      })

      const chunks: Buffer[] = []
      let streamEnded = false
      let streamError: Error | null = null
      let notify: (() => void) | null = null

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        if (notify) {
          const n = notify
          notify = null
          n()
        }
      })
      stream.on('end', () => {
        streamEnded = true
        if (notify) {
          const n = notify
          notify = null
          n()
        }
      })
      stream.on('error', (err) => {
        console.error('[ChatGPTCodexClient] Stream read error:', err.message)
        streamError = err
        streamEnded = true
        if (notify) {
          const n = notify
          notify = null
          n()
        }
      })

      // 逐块解析，实时 yield
      let chunkIdx = 0
      while (true) {
        // 等待新数据到达或流结束
        while (chunkIdx >= chunks.length && !streamEnded) {
          await new Promise<void>((resolve) => { notify = resolve })
        }

        // 流已结束且没有更多数据
        if (chunkIdx >= chunks.length && streamEnded) {
          if (streamError) {
            throw streamError
          }
          return
        }

        const chunk = chunks[chunkIdx++]
        const events = parser.parse(chunk.toString())
        for (const sseEvent of events) {
          if (sseEvent.data === '[DONE]') {
            return
          }
          try {
            const parsed = JSON.parse(sseEvent.data)
            if (!parsed.type) {
              continue
            }
            if (parsed.type && (
              parsed.type === 'response.created' ||
              parsed.type === 'response.output_item.added' ||
              parsed.type === 'response.output_item.done' ||
              parsed.type === 'response.output_text.delta' ||
              parsed.type === 'response.output_text.done' ||
              parsed.type === 'response.reasoning_text.delta' ||
              parsed.type === 'response.reasoning_text.done' ||
              parsed.type === 'response.reasoning_summary_text.delta' ||
              parsed.type === 'response.reasoning_summary_text.done' ||
              parsed.type === 'response.web_search_call.started' ||
              parsed.type === 'response.web_search_call.in_progress' ||
              parsed.type === 'response.web_search_call.searching' ||
              parsed.type === 'response.web_search_call.completed' ||
              parsed.type === 'response.web_search_call.failed' ||
              parsed.type === 'response.completed' ||
              parsed.type === 'error'
            )) {
              yield parsed as ResponsesSSEEvent
            }
          } catch {
            // 跳过无法解析的 SSE 数据
          }
        }
      }
    } finally {
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler)
      }
    }
  }
}

// ---- Mock Implementation ----

const MOCK_DELAY_MS = 30
const MOCK_CHUNK_SIZE = 3

const MOCK_RESPONSES = [
  '当然可以！让我来帮你解答这个问题。\n\n首先，我们需要理解这个问题的核心概念。',
  '这是一个很好的问题。让我从以下几个方面来分析：\n\n1. **基本概念**\n2. **实现方式**\n3. **最佳实践**\n\n以下是详细说明：',
  '```javascript\n// 这是一个示例代码\nfunction hello() {\n  console.log("Hello, World!");\n}\n\nhello();\n```\n\n上面的代码展示了基本的实现方式。',
  '让我总结一下：\n\n- 要点一：保持代码简洁\n- 要点二：注意性能优化\n- 要点三：做好错误处理\n\n希望这对你有帮助！',
  '根据你的需求，我推荐使用以下方案：\n\n| 方案 | 优点 | 缺点 |\n|------|------|------|\n| A | 简单易用 | 性能一般 |\n| B | 高性能 | 复杂度高 |\n\n综合考虑，方案A更适合你的场景。',
]

export class MockChatGPTCodexClient implements ChatGPTCodexClient {
  async listModels(): Promise<ChatGPTModel[]> {
    return [
      {
        slug: 'gpt-5',
        id: 'gpt-5',
        display_name: 'GPT-5',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        input_modalities: ['text'],
        supports_personality: true,
        is_default: true,
      },
      {
        slug: 'gpt-5-mini',
        id: 'gpt-5-mini',
        display_name: 'GPT-5 Mini',
        default_reasoning_level: 'low',
        supported_reasoning_levels: ['none', 'low', 'medium'],
        input_modalities: ['text'],
        supports_personality: false,
        is_default: false,
      },
      {
        slug: 'gpt-4o',
        id: 'gpt-4o',
        display_name: 'GPT-4o',
        default_reasoning_level: null,
        supported_reasoning_levels: [],
        input_modalities: ['text', 'image'],
        supports_personality: true,
        is_default: false,
      },
    ]
  }

  async *sendResponses(_request: ResponsesRequest, signal?: AbortSignal): AsyncIterable<ResponsesSSEEvent> {
    if (signal?.aborted) return

    const responseText = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)]

    yield {
      type: 'response.created',
      response: { id: 'mock-response-id', status: 'in_progress' },
    }

    for (let i = 0; i < responseText.length; i += MOCK_CHUNK_SIZE) {
      if (signal?.aborted) {
        return
      }

      await this.delay(MOCK_DELAY_MS + Math.random() * 50)

      const chunk = responseText.slice(i, i + MOCK_CHUNK_SIZE)
      yield {
        type: 'response.output_text.delta',
        delta: chunk,
      }
    }

    await this.delay(MOCK_DELAY_MS)

    yield {
      type: 'response.output_text.done',
      text: responseText,
    }

    yield {
      type: 'response.completed',
      response: { id: 'mock-response-id', status: 'completed' },
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}