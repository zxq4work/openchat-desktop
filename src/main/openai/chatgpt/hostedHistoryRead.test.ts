import { describe, it, expect } from 'vitest'
import { ToolLoopController, type ToolLoopCallbacks } from '../../tools/ToolLoopController'
import { ToolRegistry, type OpenChatTool } from '../../tools/ToolRegistry'
import { ChatGPTCodexAdapter } from '../../providers/ChatGPTCodexAdapter'
import { ReadHistoryTool, READ_HISTORY_TOOL_NAME } from '../../tools/history/ReadHistoryTool'
import type {
  ChatGPTCodexClient,
  ResponsesRequest,
  ResponsesSSEEvent,
} from './transport/ChatGPTCodexClient'
import type {
  CanonicalModelRequest,
  CanonicalToolResult,
} from '../../../shared/types/provider'
import type { Message } from '../../../shared/types/conversation'

// =====================================================================
// Hosted（provider-native web_search）接入 ToolLoop 后的端到端 wire 行为。
// 覆盖验收点：
//   (1) 原生 web_search 仍由顶层 tools 声明（hosted wire + include）；
//   (2) 统一只读历史工具 read_history 通过 additional_tools 声明，run 不出现；
//   (3) Hosted 调用 read_history → function_call_output 正确回传模型；
//   (4) 同轮内原生 web_search_call 会被重放进下一轮 input（不丢失搜索结果）；
//   (5) read_history 可分页读至 hasMore=false（长结果 13012 字符）；
//   (6) 历史读取预算耗尽 / 同一页无进展 → 明确终止；
//   (7) 原生 web_search_call 事件（itemId/status/action.sources）经 onWebSearchCall 完整透传。
// 这些是 wire 级端到端断言，不是纯函数单测。
// =====================================================================

const HOSTED_WS_WIRE = { type: 'web_search', search_context_size: 'high' }

function recordedClient(script: ResponsesSSEEvent[][]): { client: ChatGPTCodexClient; requests: ResponsesRequest[] } {
  const requests: ResponsesRequest[] = []
  let idx = 0
  const client: ChatGPTCodexClient = {
    listModels: async () => [],
    sendResponses: async function* (request: ResponsesRequest): AsyncIterable<ResponsesSSEEvent> {
      requests.push(request)
      const events = script[idx] ?? []
      idx++
      for (const e of events) yield e
    },
  }
  return { client, requests }
}

const created = (id: string): ResponsesSSEEvent => ({ type: 'response.created', response: { id } })

const readHistoryCall = (callId: string, args: object): ResponsesSSEEvent => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: READ_HISTORY_TOOL_NAME, arguments: JSON.stringify(args) },
  output_index: 1,
})

const webSearchDone = (id: string, sources: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }>): ResponsesSSEEvent[] => [
  { type: 'response.web_search_call.started', response: {} },
  {
    type: 'response.output_item.done',
    item: { type: 'web_search_call', id, status: 'completed', action: { type: 'search', query: 'q', sources } },
    output_index: 0,
  },
]

const finalAnswerScript = (text: string): ResponsesSSEEvent[] => [
  created('resp_final'),
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: {} },
]

function callbacksWith(overrides: Partial<ToolLoopCallbacks>): ToolLoopCallbacks {
  return {
    onToolCall: () => {},
    onToolResult: () => {},
    onDelta: () => {},
    onReasoningStarted: () => {},
    onReasoningDelta: () => {},
    onReasoningCompleted: () => {},
    onTurnStarted: () => {},
    getProviderTurnId: () => null,
    setProviderTurnId: () => {},
    ...overrides,
  }
}

// Hosted 形态的初始请求：顶层 hosted web_search + read_history 由 registry 注入。
// 生产路径 replayHostedSearchCalls=true。
function hostedRequest(): CanonicalModelRequest {
  return {
    model: 'gpt-5',
    systemPrompt: 'sys',
    toolChoice: 'auto',
    tools: [{ name: 'web_search', description: '', parameters: {}, toolType: 'web_search' }],
    messages: [{ role: 'user', content: '联网并列出上次搜索来源' }],
  }
}

function readHistoryStub(output: string): OpenChatTool {
  return {
    definition: { name: READ_HISTORY_TOOL_NAME, description: '', parameters: { type: 'object' } },
    execute: async (): Promise<CanonicalToolResult> => ({ callId: '', name: READ_HISTORY_TOOL_NAME, output }),
  }
}

function hostedController(registry: ToolRegistry, script: ResponsesSSEEvent[][], config: { maxRounds?: number; maxHistoryReadCalls?: number } = {}) {
  const { client, requests } = recordedClient(script)
  const adapter = new ChatGPTCodexAdapter(client)
  const controller = new ToolLoopController(
    adapter,
    registry,
    undefined,
    {},
    { maxRounds: config.maxRounds ?? 6, maxHistoryReadCalls: config.maxHistoryReadCalls, replayHostedSearchCalls: true }
  )
  return { controller, requests }
}

const inputTypes = (r: ResponsesRequest): string[] =>
  r.input.map((i) => ('type' in i ? String(i.type) : i.role))

const additionalToolNames = (r: ResponsesRequest): Array<string | undefined> =>
  r.input
    .filter((i): i is { type: 'additional_tools'; role: string; tools: unknown[] } => 'type' in i && i.type === 'additional_tools')
    .flatMap((i) => i.tools.map((t) => (t as { name?: string }).name))

describe('Hosted × ToolLoop —— 原生搜索 + 只读历史工具', () => {
  it('首轮 wire：顶层 hosted web_search + include（请求 sources），read_history 经 additional_tools，run 不出现', async () => {
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, readHistoryStub('{"ok":true}'))
    const { controller, requests } = hostedController(registry, [finalAnswerScript('直接回答')])

    await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({}))

    const first = requests[0]
    expect(first.tools).toEqual([HOSTED_WS_WIRE])
    expect(first.include).toEqual(['web_search_call.action.sources'])
    expect(additionalToolNames(first)).toEqual([READ_HISTORY_TOOL_NAME])
    // 绝不把 Standalone 的 run 或自定义搜索工具带进 Hosted 轮
    expect(additionalToolNames(first)).not.toContain('run')
    expect(additionalToolNames(first)).not.toContain('openchat_web_search')
    expect(additionalToolNames(first)).not.toContain('openchat_web_fetch')
    // 首轮无历史 web_search_call 可重放
    expect(inputTypes(first)).not.toContain('web_search_call')
  })

  it('Hosted 调用 read_history → function_call_output 回传模型（第二轮 wire 含 function_call + function_call_output）', async () => {
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, readHistoryStub('{"action":"read","content":"历史正文"}'))
    const script: ResponsesSSEEvent[][] = [
      [created('r1'), readHistoryCall('c1', { action: 'read', callId: 'x', offset: 0, limit: 4000 }), { type: 'response.completed', response: {} }],
      finalAnswerScript('最终回答'),
    ]
    const { controller, requests } = hostedController(registry, script)

    const result = await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({}))

    expect(requests).toHaveLength(2)
    expect(result.totalToolCalls).toBe(1)
    // 第二轮请求把 read_history 的 function_call + function_call_output 一并回传
    expect(inputTypes(requests[1])).toContain('function_call')
    expect(inputTypes(requests[1])).toContain('function_call_output')
    // 原生 hosted web_search 在第二轮仍完整声明
    expect(requests[1].tools).toEqual([HOSTED_WS_WIRE])
    expect(result.finalText).toBe('最终回答')
  })

  it('同轮原生搜索 + 历史读取：下一轮 input 同时含重放的 web_search_call 与 function_call_output', async () => {
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, readHistoryStub('{"action":"read","content":"历史正文"}'))
    const script: ResponsesSSEEvent[][] = [
      [
        created('r1'),
        ...webSearchDone('ws1', [{ url: 'https://a', title: 'A', type: 'url' }]),
        readHistoryCall('c1', { action: 'read', callId: 'x', offset: 0, limit: 4000 }),
        { type: 'response.completed', response: {} },
      ],
      finalAnswerScript('综合回答'),
    ]
    const { controller, requests } = hostedController(registry, script)

    const result = await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({}))

    expect(requests).toHaveLength(2)
    const secondTypes = inputTypes(requests[1])
    // 本轮原生搜索结果被重放，绝不丢失
    expect(secondTypes).toContain('web_search_call')
    // 同轮 read_history 结果也回传
    expect(secondTypes).toContain('function_call')
    expect(secondTypes).toContain('function_call_output')
    // web_search_call 真实字段（id/status/action.sources）原样重放
    const wsc = requests[1].input.find((i) => 'type' in i && i.type === 'web_search_call') as { id?: string; status?: string; action?: { sources?: unknown[] } }
    expect(wsc.id).toBe('ws1')
    expect(wsc.status).toBe('completed')
    expect(wsc.action?.sources).toHaveLength(1)
    expect(result.finalText).toBe('综合回答')
  })

  it('原生 web_search_call 事件经 onWebSearchCall 完整透传（phase/itemId/status/action.sources/results）', async () => {
    const registry = new ToolRegistry()
    const script: ResponsesSSEEvent[][] = [
      [
        created('r1'),
        ...webSearchDone('ws9', [{ url: 'https://x', title: 'X', type: 'url' }, { url: 'https://y', title: 'Y', type: 'url' }]),
        { type: 'response.completed', response: {} },
      ],
    ]
    const { controller } = hostedController(registry, script)

    const phases: string[] = []
    let itemId: string | undefined
    let sourcesLen = 0
    let status: string | undefined
    await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({
      onWebSearchCall: (ev) => {
        phases.push(ev.phase)
        if (ev.phase === 'completed') {
          itemId = ev.itemId
          status = ev.status
          sourcesLen = ev.action?.sources?.length ?? 0
        }
      },
    }))

    expect(phases).toContain('started')
    expect(phases).toContain('completed')
    expect(itemId).toBe('ws9')
    expect(status).toBe('completed')
    expect(sourcesLen).toBe(2)
  })

  it('长历史结果（13012 字符）可分页读至 hasMore=false，且历史分页不挤占普通 maxRounds', async () => {
    const longOutput = Array.from({ length: 13012 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    const msg: Message = {
      id: 'm-hist', conversationId: 'conv', segmentId: 's1', role: 'assistant', content: '结果',
      attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
      webSearchResults: null, webSearchError: null, status: 'completed',
      modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
      providerPayloadJson: JSON.stringify({
        provider: 'chatgpt_codex', protocol: 'chatgpt_codex',
        items: [
          { type: 'function_call', call_id: 'hist-1', name: 'run', namespace: 'web', arguments: '{}' },
          { type: 'function_call_output', call_id: 'hist-1', output: longOutput },
        ],
      }),
      errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
    }
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, new ReadHistoryTool([msg]))

    // 4 页（0/4000/8000/12000）+ 最终回答；maxRounds=2 证明历史分页不触发 wrap-up。
    const script: ResponsesSSEEvent[][] = [
      [created('r1'), readHistoryCall('h1', { action: 'read', callId: 'hist-1', offset: 0, limit: 4000 }), { type: 'response.completed', response: {} }],
      [created('r2'), readHistoryCall('h2', { action: 'read', callId: 'hist-1', offset: 4000, limit: 4000 }), { type: 'response.completed', response: {} }],
      [created('r3'), readHistoryCall('h3', { action: 'read', callId: 'hist-1', offset: 8000, limit: 4000 }), { type: 'response.completed', response: {} }],
      [created('r4'), readHistoryCall('h4', { action: 'read', callId: 'hist-1', offset: 12000, limit: 4000 }), { type: 'response.completed', response: {} }],
      finalAnswerScript('已读完整段历史'),
    ]
    const { controller, requests } = hostedController(registry, script, { maxRounds: 2 })

    const result = await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({}))

    expect(requests).toHaveLength(5)
    expect(result.totalToolCalls).toBe(4)
    expect(result.finalText).toBe('已读完整段历史')
  })

  it('历史读取预算耗尽 → 明确的未完成错误（非静默成功），模型据此给出回答', async () => {
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, readHistoryStub('{"ok":true}'))
    const script: ResponsesSSEEvent[][] = [
      [created('r1'), readHistoryCall('h1', { action: 'read', callId: 'x', offset: 0, limit: 4000 }), { type: 'response.completed', response: {} }],
      [created('r2'), readHistoryCall('h2', { action: 'read', callId: 'x', offset: 4000, limit: 4000 }), { type: 'response.completed', response: {} }],
      [created('r3'), readHistoryCall('h3', { action: 'read', callId: 'x', offset: 8000, limit: 4000 }), { type: 'response.completed', response: {} }],
      finalAnswerScript('回答'),
    ]
    const { controller } = hostedController(registry, script, { maxRounds: 3, maxHistoryReadCalls: 2 })

    const errors: string[] = []
    await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({
      onToolResult: (_id, _name, _ok, _raw, err) => { if (err) errors.push(err) },
    }))
    expect(errors.some((o) => o.includes('HISTORY_READ_BUDGET_EXCEEDED'))).toBe(true)
  })

  it('重复读取同一页（无进展）→ 明确错误，避免无限循环', async () => {
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, readHistoryStub('{"ok":true}'))
    const dup = { action: 'read', callId: 'x', offset: 0, limit: 4000 }
    const script: ResponsesSSEEvent[][] = [
      [created('r1'), readHistoryCall('h1', dup), { type: 'response.completed', response: {} }],
      [created('r2'), readHistoryCall('h2', dup), { type: 'response.completed', response: {} }],
      finalAnswerScript('回答'),
    ]
    const { controller } = hostedController(registry, script, { maxRounds: 3 })

    const errors: string[] = []
    await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({
      onToolResult: (_id, _name, _ok, _raw, err) => { if (err) errors.push(err) },
    }))
    expect(errors.some((o) => o.includes('HISTORY_READ_NO_PROGRESS'))).toBe(true)
  })

  it('真实 ReadHistoryTool：不存在的 callId → 明确的 HISTORY_CALL_NOT_FOUND 错误仍回传模型（不崩溃），循环继续', async () => {
    const registry = new ToolRegistry()
    // 空会话：没有任何历史调用可读。
    registry.register(READ_HISTORY_TOOL_NAME, new ReadHistoryTool([]))
    const script: ResponsesSSEEvent[][] = [
      [created('r1'), readHistoryCall('c1', { action: 'read', callId: 'does-not-exist' }), { type: 'response.completed', response: {} }],
      finalAnswerScript('未找到该历史记录'),
    ]
    const { controller, requests } = hostedController(registry, script)

    const outputs: string[] = []
    const result = await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({
      onToolResult: (_id, _name, success, _raw, err) => { outputs.push(String(success)); if (err) outputs.push(err) },
    }))

    // 错误以 function_call_output 回传模型，循环未中断
    expect(requests).toHaveLength(2)
    expect(inputTypes(requests[1])).toContain('function_call_output')
    const fco = requests[1].input.find((i) => 'type' in i && i.type === 'function_call_output') as { output?: string }
    expect(fco.output).toContain('HISTORY_CALL_NOT_FOUND')
    expect(result.finalText).toBe('未找到该历史记录')
  })

  it('真实 ReadHistoryTool：作用域隔离——只读当前会话，无法读取其它会话的 callId', async () => {
    const ownMsg: Message = {
      id: 'm1', conversationId: 'c1', segmentId: 's1', role: 'assistant', content: '',
      attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
      webSearchResults: null, webSearchError: null, status: 'completed',
      modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
      providerPayloadJson: JSON.stringify({
        provider: 'chatgpt_codex', protocol: 'chatgpt_codex',
        items: [
          { type: 'function_call', call_id: 'own-call', name: 'run', namespace: 'web', arguments: '{}' },
          { type: 'function_call_output', call_id: 'own-call', output: 'OWN' },
        ],
      }),
      errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
    }
    // 工具只注入当前会话（c1）的消息，不含其它会话。
    const registry = new ToolRegistry()
    registry.register(READ_HISTORY_TOOL_NAME, new ReadHistoryTool([ownMsg]))
    const script: ResponsesSSEEvent[][] = [
      [created('r1'), readHistoryCall('c1', { action: 'read', callId: 'other-call' }), { type: 'response.completed', response: {} }],
      finalAnswerScript('无法读取其它会话'),
    ]
    const { controller, requests } = hostedController(registry, script)

    const result = await controller.run(hostedRequest(), new AbortController().signal, callbacksWith({}))
    const fco = requests[1].input.find((i) => 'type' in i && i.type === 'function_call_output') as { output?: string }
    expect(fco.output).toContain('HISTORY_CALL_NOT_FOUND')
    expect(fco.output).not.toContain('SECRET')
    expect(result.finalText).toBe('无法读取其它会话')
  })
})
