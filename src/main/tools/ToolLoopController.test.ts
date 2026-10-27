import { describe, it, expect } from 'vitest'
import { ToolLoopController, type ToolLoopCallbacks } from './ToolLoopController'
import { ToolRegistry, type OpenChatTool } from './ToolRegistry'
import { ChatGPTCodexAdapter } from '../providers/ChatGPTCodexAdapter'
import { CodexProtocolIsolationError } from '../providers/errors'
import type {
  ChatGPTCodexClient,
  ResponsesRequest,
  ResponsesSSEEvent,
} from '../openai/chatgpt/transport/ChatGPTCodexClient'
import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  OpenChatToolDefinition,
  CanonicalToolResult,
} from '../../shared/types/provider'

// =====================================================================
// 行为回归：Standalone 轮出现意外 hosted web_search_call 时，隔离兜底回调抛出的
// CodexProtocolIsolationError 必须中止本轮 ToolLoop 并向上传播（绝不静默吞掉、
// 也绝不当作正常完成）。
// =====================================================================

function adapterEmitting(events: CanonicalModelEvent[]): ModelAdapter {
  return {
    protocol: 'chatgpt_codex',
    capabilities: { toolCalling: true, reasoning: true, supportsImageInput: true },
    stream: async function* (_req: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      for (const e of events) yield e
    },
  } as unknown as ModelAdapter
}

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

const req: CanonicalModelRequest = { model: 'gpt-6-astra', systemPrompt: '', messages: [] }

describe('ToolLoopController — 意外 Hosted 搜索协议隔离', () => {
  it('onWebSearchCall 抛出的 CodexProtocolIsolationError 中止本轮并向上传播', async () => {
    const adapter = adapterEmitting([
      { type: 'turn_started', turnId: 't1' },
      { type: 'web_search_call', phase: 'started' },
    ])
    const controller = new ToolLoopController(adapter, new ToolRegistry())
    const callbacks = callbacksWith({
      onWebSearchCall: () => { throw new CodexProtocolIsolationError() },
    })
    await expect(controller.run(req, new AbortController().signal, callbacks)).rejects.toBeInstanceOf(
      CodexProtocolIsolationError
    )
  })

  it('未挂 onWebSearchCall 时同一事件不抛出（回调为可选，正常路径不受影响）', async () => {
    const adapter = adapterEmitting([
      { type: 'turn_started', turnId: 't2' },
      { type: 'web_search_call', phase: 'started' },
    ])
    const controller = new ToolLoopController(adapter, new ToolRegistry())
    const result = await controller.run(req, new AbortController().signal, callbacksWith({}))
    expect(result.totalToolCalls).toBe(0)
  })
})

// =====================================================================
// 集成回归：真实 ToolLoop → ChatGPTCodexAdapter → client 的请求传递。
// 覆盖 max_rounds=2 达到轮次上限后进入 Wrap-up 的最终 wire 结构。
// 这是端到端链路断言，不是 Adapter 工具选择的纯函数单测。
// =====================================================================

const ALLOWED_RUN = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'run' }] }
const HOSTED_WS_WIRE = { type: 'web_search', search_context_size: 'high' }

// 记录每次 sendResponses 的最终 wire 请求，并按脚本逐次回放 SSE 事件。
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
const runCallScript = (callId: string): ResponsesSSEEvent[] => [
  created(`resp_${callId}`),
  {
    type: 'response.output_item.done',
    item: { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"x"}]}' },
    output_index: 0,
  },
  { type: 'response.completed', response: {} },
]
const finalAnswerScript = (text: string): ResponsesSSEEvent[] => [
  created('resp_final'),
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: {} },
]

const runDefinition: OpenChatToolDefinition = {
  name: 'run',
  description: '',
  parameters: { type: 'object' },
  namespace: 'web',
}
const runTool: OpenChatTool = {
  definition: runDefinition,
  execute: async (): Promise<CanonicalToolResult> => ({
    callId: '',
    name: 'run',
    output: '{"output":"standalone result"}',
    rawResults: [{ url: 'https://a', title: 'A' }],
  }),
}

const inputTypes = (r: ResponsesRequest): string[] =>
  r.input.map((i) => ('type' in i ? String(i.type) : i.role))

const additionalToolNames = (r: ResponsesRequest): Array<string | undefined> =>
  r.input
    .filter((i): i is { type: 'additional_tools'; role: string; tools: unknown[] } => 'type' in i && i.type === 'additional_tools')
    .flatMap((i) => i.tools.map((t) => (t as { name?: string }).name))

describe('ToolLoopController — max_rounds=2 Wrap-up 端到端 wire（Standalone 重放 Hosted 历史）', () => {
  // 复现：Standalone（Non-Lite）+ 历史 hosted web_search_call + 本轮 run 工具。
  const initialRequest = (): CanonicalModelRequest => ({
    model: 'gpt-6-astra',
    systemPrompt: '',
    toolChoice: 'auto',
    // 注意：真实 standalone 路径下 run 来自 ToolRegistry，不经 initialRequest.tools；
    // 故此处不设 tools（Wrap-up 只 spread initialRequest，不会注入 registryTools）。
    messages: [
      { role: 'user', content: 'hosted 搜索' },
      { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a', title: 'A' }] } }] },
      { role: 'assistant', content: '历史回答' },
      { role: 'user', content: '本轮问题' },
    ],
  })

  const runScenario = async () => {
    const registry = new ToolRegistry()
    registry.register('run', runTool)
    const { client, requests } = recordedClient([
      runCallScript('c1'),
      runCallScript('c2'),
      finalAnswerScript('最终回答'),
    ])
    const adapter = new ChatGPTCodexAdapter(client)
    const controller = new ToolLoopController(adapter, registry, undefined, {}, { maxRounds: 2 })

    const toolCallNames: string[] = []
    let isolationThrown = 0
    const callbacks = callbacksWith({
      onToolCall: (tc) => { toolCallNames.push(tc.name) },
      onWebSearchCall: () => { isolationThrown++; throw new CodexProtocolIsolationError() },
    })
    const result = await controller.run(initialRequest(), new AbortController().signal, callbacks)
    return { requests, result, toolCallNames, getIsolationThrown: () => isolationThrown }
  }

  it('模型连续两轮返回 run → 第三次请求即 Wrap-up，共 3 次 wire 请求', async () => {
    const { requests, result, toolCallNames, getIsolationThrown } = await runScenario()
    expect(requests).toHaveLength(3)
    // 前两轮正常执行 standalone run
    expect(toolCallNames).toEqual(['run', 'run'])
    expect(result.totalToolCalls).toBe(2)
    // Wrap-up 最终回答正常返回（未被当作异常）
    expect(result.finalText).toBe('最终回答')
    // 全程无意外 hosted 搜索事件
    expect(getIsolationThrown()).toBe(0)
  })

  it('前两轮（正常轮）：顶层 web_search 兼容声明 + allowed_tools(run) + 无 include', async () => {
    const { requests } = await runScenario()
    for (const r of [requests[0], requests[1]]) {
      expect(r.tools).toEqual([HOSTED_WS_WIRE])
      expect(r.include).toBeUndefined()
      expect(r.toolChoice).toEqual(ALLOWED_RUN)
      expect(additionalToolNames(r)).toEqual(['run'])
      // 原生 hosted 历史完整保留
      expect(r.input.filter((i) => 'type' in i && i.type === 'web_search_call')).toHaveLength(1)
    }
  })

  it('Wrap-up 轮：不声明 additional_tools(run)，tool_choice=none，保留顶层 web_search 与历史', async () => {
    const { requests } = await runScenario()
    const wrap = requests[2]
    // Wrap-up 不注入 registryTools → 无 additional_tools(run)
    expect(inputTypes(wrap)).not.toContain('additional_tools')
    expect(additionalToolNames(wrap)).toEqual([])
    // tool_choice 不再引用未声明的 run（这正是会触发 HTTP 400 的条件）
    expect(wrap.toolChoice).toBe('none')
    expect(wrap.toolChoice).not.toEqual(ALLOWED_RUN)
    // 兼容声明仍在，历史完整保留
    expect(wrap.tools).toEqual([HOSTED_WS_WIRE])
    expect(wrap.include).toBeUndefined()
    expect(wrap.input.filter((i) => 'type' in i && i.type === 'web_search_call')).toHaveLength(1)
    // 历史 tool call / output 配对完整保留
    expect(wrap.input.filter((i) => 'type' in i && i.type === 'function_call')).toHaveLength(2)
    expect(wrap.input.filter((i) => 'type' in i && i.type === 'function_call_output')).toHaveLength(2)
    // 用户设置未改动：收尾提示消息追加而非替换历史
    expect(wrap.input.some((i) => (i as { role?: string }).role === 'user' && (i as { content?: string }).content === '本轮问题')).toBe(true)
  })

  it('正常轮与 Wrap-up 的唯一 wire 差异 = tool_choice（其余逐字段相等）', async () => {
    const { requests } = await runScenario()
    const [normal, , wrap] = requests
    expect(normal.tools).toEqual(wrap.tools)
    expect(normal.include).toEqual(wrap.include)
    expect(normal.useResponsesLite).toBe(wrap.useResponsesLite)
    expect(normal.input.filter((i) => 'type' in i && i.type === 'web_search_call').length)
      .toBe(wrap.input.filter((i) => 'type' in i && i.type === 'web_search_call').length)
    expect(normal.toolChoice).toEqual(ALLOWED_RUN)
    expect(wrap.toolChoice).toBe('none')
  })

  it('无 hosted 历史的普通 Standalone：全程不注入顶层 web_search / include（原有行为不变）', async () => {
    const registry = new ToolRegistry()
    registry.register('run', runTool)
    const { client, requests } = recordedClient([
      runCallScript('c1'),
      runCallScript('c2'),
      finalAnswerScript('ok'),
    ])
    const adapter = new ChatGPTCodexAdapter(client)
    const controller = new ToolLoopController(adapter, registry, undefined, {}, { maxRounds: 2 })
    await controller.run(
      {
        model: 'gpt-6-astra',
        systemPrompt: '',
        // 生产 standalone 路径不设初始 toolChoice（仅 ToolLoop 正常轮注入 'auto'），
        // 忠实还原：Wrap-up 只 spread initialRequest → 不含 run、也不含桥。
        messages: [{ role: 'user', content: '普通 standalone 问题' }],
      },
      new AbortController().signal,
      callbacksWith({})
    )
    for (const r of requests) {
      expect(r.tools).toBeUndefined()
      expect(r.include).toBeUndefined()
    }
    // 正常轮由 ToolLoop 注入 auto；Wrap-up 非桥场景保持原有行为（不强制 none、也不引用 run）
    expect(requests[0].toolChoice).toBe('auto')
    expect(requests[1].toolChoice).toBe('auto')
    expect(requests[2].toolChoice).not.toEqual(ALLOWED_RUN)
    expect(additionalToolNames(requests[2])).toEqual([])
  })
})

// =====================================================================
// 只读历史工具（openchat_read_history）的独立、有界继续调用预算。
// 覆盖：历史分页不挤占普通 maxRounds；分页可继续直到读完；超出预算返回明确未完成；
// 重复页无进展时中止；普通工具语义不变。
// =====================================================================

const READ_HISTORY = 'openchat_read_history'

// 一轮脚本：仅发起一次指定工具调用（无最终文本），用于驱动连续多轮。
const toolCallScript = (name: string, callId: string, args: object): ResponsesSSEEvent[] => [
  created(`resp_${callId}`),
  {
    type: 'response.output_item.done',
    item: { type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args) },
    output_index: 0,
  },
  { type: 'response.completed', response: {} },
]

function readHistoryController(script: ResponsesSSEEvent[][], maxRounds: number, maxHistoryReadCalls?: number) {
  const registry = new ToolRegistry()
  registry.register(READ_HISTORY, {
    definition: { name: READ_HISTORY, description: '', parameters: { type: 'object' } },
    execute: async (): Promise<CanonicalToolResult> => ({ callId: '', name: READ_HISTORY, output: '{"ok":true}' }),
  })
  const { client, requests } = recordedClient(script)
  const adapter = new ChatGPTCodexAdapter(client)
  const controller = new ToolLoopController(adapter, registry, undefined, {}, { maxRounds, maxHistoryReadCalls })
  return { controller, requests }
}

describe('ToolLoopController — 只读历史工具独立预算', () => {
  it('maxRounds=2 时历史分页可继续到 hasMore=false（不挤占普通轮）', async () => {
    // 4 次 read（模拟分页）+ 1 次 final。普通 maxRounds=2 但历史读取不应触发 wrap-up。
    const script = [
      toolCallScript(READ_HISTORY, 'h1', { action: 'read', callId: 'c', offset: 0, limit: 4000 }),
      toolCallScript(READ_HISTORY, 'h2', { action: 'read', callId: 'c', offset: 4000, limit: 4000 }),
      toolCallScript(READ_HISTORY, 'h3', { action: 'read', callId: 'c', offset: 8000, limit: 4000 }),
      toolCallScript(READ_HISTORY, 'h4', { action: 'read', callId: 'c', offset: 12000, limit: 4000 }),
      finalAnswerScript('已读完'),
    ]
    const { controller, requests } = readHistoryController(script, 2)
    const result = await controller.run(req, new AbortController().signal, callbacksWith({}))
    // 5 次 wire 请求：4 次历史 read + 1 次最终回答；未在 maxRounds=2 处被迫 wrap-up
    expect(requests).toHaveLength(5)
    expect(result.totalToolCalls).toBe(4)
    expect(result.finalText).toBe('已读完')
  })

  it('超出历史读取预算 → 返回明确未完成错误（不是静默成功），模型据此给出回答', async () => {
    // maxHistoryReadCalls=2，但脚本请求 3 次 read → 第 3 次被拦截为预算耗尽。
    const script = [
      toolCallScript(READ_HISTORY, 'h1', { action: 'read', callId: 'c', offset: 0, limit: 4000 }),
      toolCallScript(READ_HISTORY, 'h2', { action: 'read', callId: 'c', offset: 4000, limit: 4000 }),
      toolCallScript(READ_HISTORY, 'h3', { action: 'read', callId: 'c', offset: 8000, limit: 4000 }),
      finalAnswerScript('回答'),
    ]
    const { controller } = readHistoryController(script, 3, 2)
    const outputs: string[] = []
    await controller.run(req, new AbortController().signal, callbacksWith({
      onToolResult: (_id, _name, _ok, _raw, err) => { if (err) outputs.push(err) },
    }))
    expect(outputs.some((o) => o.includes('HISTORY_READ_BUDGET_EXCEEDED'))).toBe(true)
  })

  it('重复读取同一页（无进展）→ 返回明确错误，避免无限循环', async () => {
    const dup = { action: 'read', callId: 'c', offset: 0, limit: 4000 }
    const script = [
      toolCallScript(READ_HISTORY, 'h1', dup),
      toolCallScript(READ_HISTORY, 'h2', dup), // 与 h1 完全相同的页 → 无进展
      finalAnswerScript('回答'),
    ]
    const { controller } = readHistoryController(script, 3)
    const outputs: string[] = []
    await controller.run(req, new AbortController().signal, callbacksWith({
      onToolResult: (_id, _name, _ok, _raw, err) => { if (err) outputs.push(err) },
    }))
    expect(outputs.some((o) => o.includes('HISTORY_READ_NO_PROGRESS'))).toBe(true)
  })

  it('普通工具仍严格受 maxRounds 限制（历史预算不影响普通搜索轮次）', async () => {
    const registry = new ToolRegistry()
    registry.register('run', runTool)
    const { client, requests } = recordedClient([
      runCallScript('c1'),
      runCallScript('c2'),
      finalAnswerScript('最终回答'),
    ])
    const adapter = new ChatGPTCodexAdapter(client)
    // 提供很大的历史预算，但普通 run 仍应在 maxRounds=2 处 wrap-up。
    const controller = new ToolLoopController(adapter, registry, undefined, {}, { maxRounds: 2, maxHistoryReadCalls: 50 })
    const result = await controller.run(
      { model: 'gpt-6-astra', systemPrompt: '', messages: [{ role: 'user', content: '问题' }] },
      new AbortController().signal,
      callbacksWith({})
    )
    expect(requests).toHaveLength(3)
    expect(result.totalToolCalls).toBe(2)
    expect(result.finalText).toBe('最终回答')
  })
})
