import * as fs from 'fs'
import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  CanonicalMessage,
  ProviderProtocol,
} from '../../shared/types/provider'
import type {
  ChatGPTCodexClient,
  ProviderInputContentItem,
  ProviderInputItem,
  ResponsesSSEEvent,
} from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { UnsupportedImageInputError } from './errors'

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export class ChatGPTCodexAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'chatgpt_codex'
  readonly capabilities = { toolCalling: true, reasoning: true, supportsImageInput: true }

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
    reasoning?: { effort: string; summary: string; context?: string }
    useResponsesLite?: boolean
    tools?: unknown[]
    include?: string[]
    toolChoice?: string | { type: string }
  } {
    const input: ProviderInputItem[] = []

    // Responses Lite 完全由模型 metadata 驱动（CanonicalModelRequest.responsesLite）。
    // undefined / false 均不发送 header 与 reasoning.context；绝不在 Adapter 内按 slug 猜测。
    const useResponsesLite = request.responsesLite === true

    // 分离 hosted 工具（如官方 web_search）与 client 工具（function/custom）。
    // Lite 与普通 Responses 的 tool serialization 必须分开：
    //   - 普通 Responses：hosted 工具放顶层 tools（+ include）
    //   - Responses Lite：不接受普通 hosted Responses tools，hosted 工具一律丢弃；
    //     client-executed 工具通过 input 的 additional_tools 描述。
    const { hostedTools, clientTools } = this.serializeTools(request, useResponsesLite)

    // client 工具放入 additional_tools
    if (clientTools.length > 0) {
      input.unshift({
        type: 'additional_tools',
        role: 'developer',
        tools: clientTools,
      })
    }

    for (const msg of request.messages) {
      input.push(...this.convertMessages(msg, request))
    }

    console.log('[Codex Adapter] buildRequest input items=', input.length,
      'types=', input.map(i => 'type' in i ? i.type : i.role).join(','))

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
      useResponsesLite: useResponsesLite || undefined,
    }

    // hosted 工具：顶层 tools + include 请求来源 URL。Lite 下 hostedTools 恒为空，不会发送。
    if (hostedTools.length > 0) {
      req.tools = hostedTools
      req.include = ['web_search_call.action.sources']
    }

    // tool_choice 映射：'required' 且存在 hosted web_search 时，强制 web_search。
    // Lite 无 hosted 工具，退化为 'auto'/'none'，绝不构造 hosted tool_choice。
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
      if (useResponsesLite) {
        reasoning.context = 'all_turns'
      }
      req.reasoning = reasoning
    }

    return req
  }

  // 已知的 hosted Responses 工具类型：这些只能出现在普通 Responses 的顶层 tools，
  // Lite 一律不支持（服务器错误：Lite only supports function tools, custom tools,
  // and client-executed tool search）。
  // 注意：web_search 是当前 OpenChat 唯一「已实现」hosted wire serialization 的类型；
  // 其余类型仅登记为 known hosted，OpenChat serializer 尚未实现其 wire shape，
  // 绝不把它们错误序列化为 function（详见 serializeTools 的 Non-Lite 分支）。
  private static readonly KNOWN_HOSTED_TOOL_TYPES = new Set([
    'web_search',
    'file_search',
    'image_generation',
    'computer_use',
    'code_interpreter',
  ])

  // 工具序列化：普通 Responses 与 Lite 两套语义分开。
  // 返回 { hostedTools（顶层 tools）, clientTools（additional_tools）}。
  private serializeTools(
    request: CanonicalModelRequest,
    useResponsesLite: boolean
  ): { hostedTools: unknown[]; clientTools: unknown[] } {
    const hostedTools: unknown[] = []
    const clientTools: unknown[] = []

    for (const t of request.tools ?? []) {
      if (useResponsesLite) {
        // Lite：绝不发送普通 hosted Responses tools。
        if (ChatGPTCodexAdapter.KNOWN_HOSTED_TOOL_TYPES.has(t.toolType ?? '')) {
          if (isDev()) console.warn('[Codex Adapter] Lite: dropping hosted tool type=%s name=%s', t.toolType, t.name)
          continue
        }
        // Lite 允许 function / custom（client-executed）。
        if (t.toolType === 'function' || t.toolType === 'custom' || t.toolType == null) {
          clientTools.push(this.toClientTool(t, true))
        } else {
          // 未知 tool type：绝不静默发送，开发模式告警并排除。
          if (isDev()) console.warn('[Codex Adapter] Lite: unsupported tool type=%s name=%s, excluding', t.toolType, t.name)
        }
        continue
      }

      // 普通 Responses：
      //   - web_search：OpenChat 已实现的 hosted wire shape。
      //   - 其他 known hosted tool：OpenChat serializer 尚未实现其 wire shape，
      //     绝不降级成 function（那是另一种协议语义）；开发告警并安全排除。
      //   - 其余（function / custom / null）：保持既有 client tool 行为不变。
      if (t.toolType === 'web_search') {
        hostedTools.push({
          type: 'web_search',
          search_context_size: 'high',
        })
      } else if (ChatGPTCodexAdapter.KNOWN_HOSTED_TOOL_TYPES.has(t.toolType ?? '')) {
        if (isDev()) console.warn('[Codex Adapter] Non-Lite: known hosted tool type=%s name=%s is not implemented by OpenChat serializer, excluding', t.toolType, t.name)
      } else {
        clientTools.push(this.toClientTool(t, false))
      }
    }

    return { hostedTools, clientTools }
  }

  // 非 Lite 保持历史行为：client 工具一律 type='function'。
  // Lite 额外允许 custom 类型（服务器声明支持 custom tools）。
  private toClientTool(
    t: { name: string; description: string; parameters: Record<string, unknown>; toolType?: string },
    allowCustom: boolean
  ): unknown {
    return {
      type: allowCustom && t.toolType === 'custom' ? 'custom' : 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  }

  private convertMessages(msg: CanonicalMessage, request: CanonicalModelRequest): ProviderInputItem[] {
    // function_call_output（工具执行结果）
    if (msg.toolResult) {
      return [{
        type: 'function_call_output' as const,
        call_id: msg.toolResult.callId,
        output: msg.toolResult.output,
      }]
    }

    // 用户消息多模态：转换为 Codex 支持的 input_text / input_image 内容项。
    // 图片无法解析/读取时必须显式失败，绝不静默丢弃 image part 降级为纯文本。
    if (msg.inputParts && msg.inputParts.length > 0 && (msg.role === 'user' || msg.role === 'developer')) {
      const content: ProviderInputContentItem[] = []
      for (const part of msg.inputParts) {
        if (part.type === 'text') {
          content.push({ type: 'input_text', text: part.text })
        } else if (part.type === 'image') {
          const resolved = request.attachmentResolver?.resolveForProvider(part.attachmentId)
          if (!resolved) {
            throw new UnsupportedImageInputError('图片附件无法解析')
          }
          const dataUrl = this.readImageDataUrl(resolved.storagePath, resolved.mimeType)
          if (!dataUrl) {
            throw new UnsupportedImageInputError('图片文件读取失败')
          }
          content.push({ type: 'input_image', image_url: dataUrl, detail: part.detail ?? resolved.detail ?? 'auto' })
        }
      }
      if (content.length > 0) {
        return [{ role: msg.role === 'developer' ? 'developer' : 'user', content }]
      }
    }

    // assistant 消息：buildCanonicalRequest 已拆分为独立消息，每条只有一种内容
    if (msg.role === 'assistant') {
      // web_search_call（Hosted 搜索）
      if (msg.webSearchCalls && msg.webSearchCalls.length > 0) {
        return msg.webSearchCalls.map((wsc) => ({
          type: 'web_search_call' as const,
          id: wsc.id,
          ...(wsc.status ? { status: wsc.status } : {}),
          action: wsc.action ? { ...wsc.action, type: wsc.action.type ?? 'search' } : { type: 'search' },
        }))
      }

      // function_call（Standalone web.run / Custom tool）
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        return msg.toolCalls.map((tc) => ({
          type: 'function_call' as const,
          call_id: tc.id,
          name: tc.name,
          namespace: tc.namespace,
          arguments: tc.arguments,
        }))
      }

      // 最终 assistant 文本
      if (msg.content) {
        return [{ role: 'assistant', content: msg.content }]
      }

      return []
    }

    return [{
      role: msg.role === 'developer' ? 'developer' : msg.role,
      content: msg.content ?? '',
    }]
  }

  private readImageDataUrl(storagePath: string, mimeType: string): string | null {
    try {
      const buffer = fs.readFileSync(storagePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      // 不打印本地路径，避免文件系统信息进入日志
      console.error('[ChatGPTCodexAdapter] failed to read image attachment')
      return null
    }
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
            console.log('[Codex Adapter] annotations count=', annotations.length)
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
        // hosted web_search 结果：item.type === 'web_search_call'，原样保留服务端字段
        if (event.item.type === 'web_search_call') {
          const item = event.item as { type: string; id: string; status?: string; action?: { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string; sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> } }
          const action = item.action ? { type: item.action.type ?? 'search', ...item.action } : { type: 'search' }
          const sources = action.sources ?? []
          return {
            type: 'web_search_call',
            phase: 'completed',
            itemId: item.id,
            status: item.status,
            action,
            results: sources,
          }
        }
        return null

      case 'response.web_search_call.started':
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        return { type: 'web_search_call', phase: 'started' }

      case 'response.web_search_call.completed':
        // 不在此处发射 completed，避免与 output_item.done (web_search_call) 重复
        // 此事件仅作为搜索完成的信号，实际 sources 由 output_item.done 提供
        return { type: 'web_search_call', phase: 'searching' }

      case 'response.web_search_call.failed':
        return { type: 'web_search_call', phase: 'failed' }

      case 'response.completed':
        return { type: 'turn_completed' }

      case 'error':
        return { type: 'error', code: event.error.code, message: event.error.message }

      default:
        return null
    }
  }
}
