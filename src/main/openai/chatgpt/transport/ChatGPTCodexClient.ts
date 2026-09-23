import type { IncomingMessage } from 'http'
import { ResponsesStreamParser } from './ResponsesStreamParser'
import type { OAuthCredentialManager } from '../auth/OAuthCredentialManager'
import { createRequest } from '../httpsClient'
import { logNon2xxResponse } from '../rateLimitDiagnostics'
import { CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL } from '../models/modelCatalogDiscovery'

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

// ChatGPT /models 原始响应模型。
// 故意宽松：所有能力 metadata 均为 optional，并保留 [key: string]: unknown，
// 使 OpenAI 未来新增字段（或未知模型）都不会导致整个列表解析失败。
// 注意：Codex Agent 私有 metadata（model_messages / guardian / confirmation_policies /
// multi_agent prompt / permissions 等）在此不作强类型声明，OpenChat 不消费它们。
export interface ChatGPTModel {
  slug: string
  id?: string
  display_name?: string
  description?: string

  default_reasoning_level?: string | { effort?: string; level?: string; reasoning_effort?: string; reasoning_level?: string; value?: string } | null
  supported_reasoning_levels?: Array<string | { effort?: string; level?: string; reasoning_effort?: string; reasoning_level?: string; value?: string; description?: string }>

  visibility?: string
  supported_in_api?: boolean
  minimal_client_version?: string
  priority?: number

  use_responses_lite?: boolean
  supports_reasoning_effort_updates?: boolean
  supports_parallel_tool_calls?: boolean

  input_modalities?: string[]
  supports_image_detail_original?: boolean

  context_window?: number
  max_context_window?: number
  effective_context_window_percent?: number

  supports_search_tool?: boolean
  web_search_tool_type?: string | null

  support_verbosity?: boolean
  default_verbosity?: string

  tool_mode?: string | null
  multi_agent_version?: string | null
  multi_agent_reasoning_effort?: string | null

  service_tiers?: Array<{ id?: string; name?: string; description?: string }>
  default_service_tier?: string | null
  additional_speed_tiers?: string[]

  experimental_supported_tools?: string[]

  // 兼容旧解析路径
  supports_personality?: boolean
  is_default?: boolean
  base_instructions?: string

  [key: string]: unknown
}

// Codex 用户消息的多模态内容项（与 vendor codex ContentItem schema 一致）。
// input_image 的 image_url 为 data URL，detail 取自动画的判断。
export type ProviderInputContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string }

// Provider 输入项：支持普通消息、additional_tools 声明，
// function_call（模型工具调用）以及 function_call_output（工具回传结果）
export type ProviderInputItem =
  | { role: string; content: string | ProviderInputContentItem[] }
  | { type: 'additional_tools'; role: string; tools: unknown[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; namespace?: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'web_search_call'; id: string; status?: string; action?: WebSearchAction }

// Hosted WebSearch action：保留服务端原始字段（type/query/queries/url/pattern/sources）
export interface WebSearchAction {
  type: string
  query?: string
  queries?: string[]
  url?: string
  pattern?: string
  sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }>
}

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
  | { type: 'response.output_item.done'; item: { type: string; id: string; status?: string; summary?: Array<{ type: string; text: string }>; encrypted_content?: string; name?: string; namespace?: string; call_id?: string; arguments?: string; action?: WebSearchAction; annotations?: unknown[] }; output_index: number }
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

// ---- Pure helpers（导出以便单测；不含网络）----

// 模型目录 URL：client_version 只能出现在这里，绝不出现在 /responses。
// 参数本身由 backend 要求（省略会 400），其值使用 catalog discovery sentinel。
export function buildModelsCatalogUrl(clientVersion: string): string {
  return `${BASE_URL}/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`
}

// 真正的聊天端点：不携带 client_version（catalog version 仅属于 /models）。
export function buildResponsesUrl(): string {
  return `${BASE_URL}/backend-api/codex/responses`
}

// 构造 /responses 请求 headers。Responses Lite 仅在 useResponsesLite === true 时发送 header。
// 不伪造 Codex CLI 身份（不加 originator / User-Agent / version）。
export function buildResponsesHeaders(
  token: string,
  accountId: string | null,
  useResponsesLite?: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  }
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId
  }
  if (useResponsesLite === true) {
    headers['x-openai-internal-codex-responses-lite'] = 'true'
  }
  return headers
}

// 已知的 Responses SSE event 类型集合。未知 event 一律宽松忽略（不 throw、不终止 stream），
// 便于 OpenAI 协议演进时不破坏整个流；已知的错误类 event（error）仍正常上报。
export const KNOWN_SSE_EVENT_TYPES = new Set<string>([
  'response.created',
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.web_search_call.started',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.web_search_call.failed',
  'response.completed',
  'error',
])

function isDevelopment(): boolean {
  return process.env.NODE_ENV !== 'production'
}

// 未知 event 返回 false：调用方据此宽松忽略该 event（不 throw、不结束 stream）。
export function isKnownSSEEventType(type: string): boolean {
  return KNOWN_SSE_EVENT_TYPES.has(type)
}

// 构造 /responses 请求 body。纯函数，导出以便单测断言 Lite 固定字段：
//   - Lite：parallel_tool_calls=false；绝不因 hosted tools 注入 tools/include。
//   - non-Lite：保持既有行为（tools/include 原样）。
export function buildResponsesBody(request: ResponsesRequest): Record<string, unknown> {
  return {
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
  }
}

// 多模态 input content 的脱敏摘要：仅返回 content item 的 type 列表（如 input_text / input_image）。
// 绝不返回 text、image_url、base64、本地路径。
export function summarizeInputContentTypes(request: ResponsesRequest): Array<string[]> {
  const result: Array<string[]> = []
  for (const item of request.input) {
    if ('content' in item && Array.isArray(item.content)) {
      result.push(item.content.map((c) => c.type))
    }
  }
  return result
}

// 从 data URL 前缀提取 MIME（如 data:image/png;base64 → image/png）。
// 仅返回 MIME 段，绝不返回 base64 内容或完整 data URL。
export function extractDataUrlMime(imageUrl: string): string | null {
  const m = /^data:([^;,]+)[;,]/.exec(imageUrl)
  return m ? m[1] : null
}

// 脱敏的 Responses 请求 shape 摘要（仅供开发诊断）。
// 绝不含 token / account id / prompt / 用户消息 / 图片 base64 / 完整 tool schema。
export function summarizeResponsesShape(request: ResponsesRequest): Record<string, unknown> {
  const inputTypes = request.input.map((i) => ('type' in i && typeof i.type === 'string' ? i.type : i.role))
  const additionalTools = request.input
    .filter((i): i is { type: 'additional_tools'; role: string; tools: unknown[] } => 'type' in i && i.type === 'additional_tools')
    .flatMap((i) => i.tools)
    .map((t) => {
      const o = t as { type?: string; name?: string }
      return { type: o.type, name: o.name }
    })
  const topLevelTools = (request.tools ?? []).map((t) => {
    const o = t as { type?: string; name?: string }
    return { type: o.type, name: o.name }
  })
  // 多模态脱敏摘要：content item 的 type 序列 + 图片数量 + MIME（绝不含 base64 / 路径）。
  const inputContentTypes = summarizeInputContentTypes(request)
  const imageMimeTypes: string[] = []
  for (const item of request.input) {
    if ('content' in item && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'input_image') {
          const mime = extractDataUrlMime(c.image_url)
          if (mime) imageMimeTypes.push(mime)
        }
      }
    }
  }
  return {
    model: request.model,
    effectiveResponsesLite: request.useResponsesLite === true,
    hasLiteHeader: request.useResponsesLite === true,
    hasTopLevelTools: topLevelTools.length > 0,
    topLevelToolCount: topLevelTools.length,
    topLevelTools,
    include: request.include ?? [],
    toolChoice: request.toolChoice ?? 'none',
    inputTypes,
    inputContentTypes,
    imageInputCount: imageMimeTypes.length,
    imageMimeTypes,
    additionalTools,
    parallelToolCalls: request.useResponsesLite === true ? false : undefined,
    reasoningContext: request.reasoning?.context ?? 'none',
  }
}

export class RealChatGPTCodexClient implements ChatGPTCodexClient {
  private credentialManager: OAuthCredentialManager

  constructor(credentialManager: OAuthCredentialManager) {
    this.credentialManager = credentialManager
  }

  async listModels(): Promise<ChatGPTModel[]> {
    // Discovery 模式：只用 catalog discovery sentinel 请求当前完整 catalog。
    // 没有 release-version fallback，也不根据 error body 猜测另一个 Codex release。
    // 失败一律交给上层（ChatGPTModelService 刷新失败时保留既有 model state）。
    console.log('[Models] catalog discovery sentinel=%s', CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL)

    const result = await this.fetchModelCatalog(CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL)
    if (!result.ok) {
      throw new Error(`Failed to list models: ${result.status}`)
    }
    return this.parseModelCatalog(result.json)
  }

  private async fetchModelCatalog(
    clientVersion: string
  ): Promise<{ ok: boolean; status: number; json: unknown }> {
    const token = await this.credentialManager.getAccessToken()
    const accountId = await this.credentialManager.getAccountId()

    const url = buildModelsCatalogUrl(clientVersion)
    const response = await this.fetchWithAuth(url, token, accountId)
    const body = response.text()

    let json: unknown = undefined
    if (response.ok && body) {
      try {
        json = JSON.parse(body)
      } catch {
        json = undefined
      }
    }

    return { ok: response.ok, status: response.status, json }
  }

  private parseModelCatalog(data: unknown): ChatGPTModel[] {
    // 宽松兼容：{ models: [...] } 或 { data: [...] } 或裸数组。
    let models: ChatGPTModel[] = []
    if (Array.isArray(data)) {
      models = data as ChatGPTModel[]
    } else if (data && typeof data === 'object') {
      const obj = data as { models?: unknown; data?: unknown }
      if (Array.isArray(obj.models)) {
        models = obj.models as ChatGPTModel[]
      } else if (Array.isArray(obj.data)) {
        models = obj.data as ChatGPTModel[]
      }
    }
    console.log('[Models] fetched %d models', models.length)
    return models
  }

  async *sendResponses(request: ResponsesRequest, signal?: AbortSignal): AsyncIterable<ResponsesSSEEvent> {
    const token = await this.credentialManager.getAccessToken()
    const accountId = await this.credentialManager.getAccountId()

    const body = JSON.stringify(buildResponsesBody(request))

    const parsedUrl = new URL(buildResponsesUrl())

    console.log('[ChatGPT Request]')
    console.log('endpoint=POST', parsedUrl.href)
    console.log('model=', request.model)
    console.log('instructions_length=', request.instructions.length)
    console.log('input_messages=', request.input.length)
    console.log('reasoning=', request.reasoning ?? 'none')
    if (request.tools && request.tools.length > 0) {
      console.log('[Codex Search] mode=hosted')
    } else {
      // 有 additional_tools（client tools）也是 standalone 模式
      const hasAdditionalTools = request.input.some((i) => 'type' in i && i.type === 'additional_tools')
      if (hasAdditionalTools) {
        console.log('[Codex Search] mode=standalone client-tools=true')
      } else {
        console.log('[Codex Search] mode=none')
      }
    }
    if (request.useResponsesLite) {
      console.log('[Codex Responses] responsesLite=true')
    }
    if (isDevelopment()) {
      console.log('[Responses Request Shape]', JSON.stringify(summarizeResponsesShape(request)))
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

  private async fetchWithAuth(url: string, token: string, accountId: string | null): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => string }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
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
              text: () => data,
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
    const headers = buildResponsesHeaders(token, accountId, useResponsesLite)

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
            if (isKnownSSEEventType(parsed.type)) {
              yield parsed as ResponsesSSEEvent
            } else if (isDevelopment()) {
              // 未知 SSE event：宽松忽略，不终止整个 stream，后续已知 event 继续处理。
              // 仅开发环境告警，便于发现协议演进；生产环境静默忽略。
              console.warn('[ChatGPTCodexClient] unknown SSE event type=%s (ignored)', String(parsed.type))
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

// 命中关键词时返回的 citation 格式回答（复现 ChatGPT hosted search 的真实输出）
// 包含 PUA rich citation 与 contentReference 两种真实格式
const MOCK_CITATION_RESPONSE =
  '以下是关于您问题的参考信息：\uE200cite\uE202turn0search0\uE202turn0search1\uE201\n\n测试引用：:contentReference[oaicite:2]{index=2}'

// 从请求 input 中提取最后一条 user 消息文本
function extractMockUserText(input: ProviderInputItem[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if ('role' in item && item.role === 'user' && 'content' in item) {
      if (typeof item.content === 'string') return item.content
      // 多模态：content 为 input_text / input_image 数组，拼接文本项
      if (Array.isArray(item.content)) {
        const text = item.content
          .filter((c): c is { type: 'input_text'; text: string } => c.type === 'input_text')
          .map((c) => c.text)
          .join(' ')
        if (text) return text
      }
    }
  }
  return ''
}

export class MockChatGPTCodexClient implements ChatGPTCodexClient {
  async listModels(): Promise<ChatGPTModel[]> {
    return [
      {
        slug: 'gpt-5',
        id: 'gpt-5',
        display_name: 'GPT-5',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'none' }, { effort: 'minimal' }, { effort: 'low' },
          { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' },
        ],
        input_modalities: ['text'],
        visibility: 'list',
        supported_in_api: true,
        use_responses_lite: false,
        supports_personality: true,
        is_default: true,
      },
      {
        slug: 'gpt-5-mini',
        id: 'gpt-5-mini',
        display_name: 'GPT-5 Mini',
        default_reasoning_level: 'low',
        supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'medium' }],
        input_modalities: ['text'],
        visibility: 'list',
        supported_in_api: true,
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
        visibility: 'list',
        supported_in_api: true,
        supports_personality: true,
        is_default: false,
      },
    ]
  }

  async *sendResponses(request: ResponsesRequest, signal?: AbortSignal): AsyncIterable<ResponsesSSEEvent> {
    if (signal?.aborted) return

    const userText = extractMockUserText(request.input)
    const isCitationTest = /citation|引用|cite|turn0|PUA|\uE200/.test(userText)

    const responseText = isCitationTest
      ? MOCK_CITATION_RESPONSE
      : MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)]

    if (isCitationTest) {
      console.log('[mock/citation-raw]', JSON.stringify(responseText))
    }

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