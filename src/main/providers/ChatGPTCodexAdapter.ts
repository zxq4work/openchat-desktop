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
import { logFinalRequestDebug } from './requestDebug'

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production'
}

// 跨模式历史兼容（Standalone 重放 Hosted 历史、Non-Lite）时的工具白名单：
// 仅允许 client-executed 的 function:run。mode:'auto' = 允许但不强制调用
// （避免在收尾轮被强制继续调用工具）。
//
// ⚠️ 该白名单对 Hosted web_search 的强制隔离能力尚未在真实上游充分验证；
// 因此 ConversationService 另有"意外 hosted 搜索"兜底检测（CodexProtocolIsolationError）。
const CODEX_ALLOWED_TOOLS_RUN: Record<string, unknown> = {
  type: 'allowed_tools',
  mode: 'auto',
  tools: [{ type: 'function', name: 'run' }],
}

// 该轮 wire input 是否声明了 client-executed 的 function:run（additional_tools）。
// ToolLoop 正常轮注入 registryTools（含 run），收尾轮只 spread initialRequest 不注入，
// 故收尾轮的 input 不含 run —— 据此区分「正常轮」与「收尾轮」，决定 tool_choice。
function requestDeclaresRun(input: ProviderInputItem[]): boolean {
  return input.some(
    (i) =>
      'type' in i &&
      i.type === 'additional_tools' &&
      (i.tools ?? []).some((t) => (t as { name?: string }).name === 'run')
  )
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

    // 实际最终发送参数（dev 诊断，默认关闭）：ChatGPT Codex 为受控协议，只打印顶层字段形状，
    // 绝不打印 body 内容（instructions / input 属私有请求）。Codex 路径不注入动态参数。
    logFinalRequestDebug('chatgpt_codex', responsesRequest as unknown as Record<string, unknown>, undefined)

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
    toolChoice?: unknown
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
      toolChoice?: unknown
    } = {
      model: request.model,
      instructions: request.systemPrompt ?? '',
      input,
      store: false,
      stream: true,
      useResponsesLite: useResponsesLite || undefined,
    }

    // 跨模式历史兼容（生产）：请求实际重放了 Hosted 的 web_search_call，
    // 但当前未声明 hosted web_search 工具（即 Standalone 轮）时，必须补顶层 web_search 声明，
    // 否则上游以 "response protection is unavailable" 拒绝历史重放。
    // 仅按「实际 wire 中的历史 + 是否已声明 web_search」判断，不按 slug / env / 模式名。
    const replaysHostedHistory = !useResponsesLite
      && input.some((i) => 'type' in i && i.type === 'web_search_call')
    const declaresHostedWebSearch = hostedTools.some((t) => (t as { type?: string }).type === 'web_search')
    const needsHostedHistoryBridge = replaysHostedHistory && !declaresHostedWebSearch

    // hosted 工具：顶层 tools + include 请求来源 URL。Lite 下 hostedTools 恒为空，不会发送。
    if (hostedTools.length > 0) {
      req.tools = hostedTools
      req.include = ['web_search_call.action.sources']
    } else if (needsHostedHistoryBridge) {
      // 历史兼容桥：仅为承载历史 web_search_call 而声明顶层 hosted web_search。
      // 不附带 include（include 仅用于请求 sources 回传，历史已被完整重放，无需重新抓取）。
      req.tools = [{ type: 'web_search', search_context_size: 'high' }]
    }

    // tool_choice 映射：
    //   1) 历史兼容桥场景（Standalone 重放 Hosted 历史），按调用方意图优先：
    //      - 调用方明确 toolChoice='none' → 始终保留 'none'（绝不覆盖为 allowed_tools）；
    //      - 本轮未声明 run（收尾/wrap-up 轮）→ 'none'，禁用所有新工具（含 Hosted web_search）；
    //      - 本轮声明 run 且未明确禁止 → allowed_tools(run)，隔离本轮可执行工具。
    //      ⚠️ allowed_tools 的强制力未经充分验证，故运行期另有"意外 hosted 搜索"兜底检测。
    //   2) 其余场景保持既有映射（Lite 退化 auto/none；'required'+hosted → 强制 web_search）。
    if (needsHostedHistoryBridge) {
      req.toolChoice =
        request.toolChoice === 'none' || !requestDeclaresRun(input)
          ? 'none'
          : CODEX_ALLOWED_TOOLS_RUN
    } else if (request.toolChoice) {
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
      // web_search_call（Hosted 搜索）——provider-native wire item，原样重建。
      // 传输层（Transport Policy）保证：只要历史含此 item，请求即为 Non-Lite
      // （见 resolveEffectiveResponsesLite 的 requiresNonLiteTransport），因此这里
      // 在 Lite 会话中不会出现 hosted web_search_call；无需在此按 Lite 丢弃历史。
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
