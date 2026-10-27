import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  CODEX_HOSTED_SEARCH_MODE_MARKER,
  CODEX_STANDALONE_SEARCH_MODE_MARKER,
  CODEX_SEARCH_INSTRUCTIONS,
  CODEX_STANDALONE_SEARCH_INSTRUCTIONS,
} from './codexSearchInstructions'
import { ToolLoopController, type ToolLoopCallbacks } from '../../../tools/ToolLoopController'
import { ToolRegistry } from '../../../tools/ToolRegistry'
import { ChatGPTCodexAdapter } from '../../../providers/ChatGPTCodexAdapter'
import type {
  ChatGPTCodexClient,
  ResponsesRequest,
  ResponsesSSEEvent,
} from '../transport/ChatGPTCodexClient'
import type { CanonicalModelRequest } from '../../../../shared/types/provider'
import {
  resolveAllSearchProvenance,
  buildAllProvenanceContext,
} from './SearchProvenanceResolver'
import type { Message } from '../../../../shared/types/conversation'

// =====================================================================
// 按策略隔离指令 + 本轮自我识别 回归。
//
// 背景（观测到的故障现象）：此前一轮执行 Standalone（web.run）；本轮 strategy=codex-hosted、
// 实际执行原生 web_search_call（含 oai-weather API 来源），模型却把「本轮」叙述为
// Standalone web.run / web.run.weather。
//
// 曾怀疑（未获证实）：Hosted 指令曾无条件叠加一段共享的「搜索模式语义」，其中正面描述了
// Standalone 工具 web.run。后续实验表明：完全移除该段后故障仍可复现，因此它**不是已证实的
// 根因**，只是加剧上下文混杂的一个因素。
//
// 当前取向：按搜索策略严格隔离指令 —— 每个模式只携带自身工具用法与第一人称自我识别，
// 不向一种模式描述另一种模式的机制；历史来源仍如实保留。
// 注：本文件断言的是「指令按模式隔离」这一代码不变量，不代表已找到并消除根因。
//
// 本测试覆盖（用户要求）：
//   1) 旧历史 Standalone，本轮 Hosted 网页搜索；
//   2) 旧历史 Standalone，本轮 Hosted oai-weather；
//   3) 旧历史 Hosted，本轮 Standalone；
//   4) 当前未执行搜索时，不能仅凭配置声称执行过搜索。
// 同时检查：最终有效指令中的本轮自我识别、历史模式隔离、实际执行事件对应关系。
// =====================================================================

// ---------------------------------------------------------------------
// 有效指令合成：与 ChatGPTConversationService 各生成路径完全一致的拼接方式。
// 本轮自我识别内嵌在各自搜索指令尾部，不再单独叠加 currentSearchMode 声明。
// ---------------------------------------------------------------------
function effectiveInstructions(mode: 'codex-hosted' | 'codex-standalone'): string {
  const base = 'You are a helpful assistant.'
  if (mode === 'codex-hosted') return base + '\n\n' + CODEX_SEARCH_INSTRUCTIONS
  return base + '\n\n' + CODEX_STANDALONE_SEARCH_INSTRUCTIONS
}

describe('按策略隔离 — 每个模式仅携带自身自我识别', () => {
  it('Hosted 有效指令带 Hosted 标记，且不含任何 Standalone 机制', () => {
    const eff = effectiveInstructions('codex-hosted')
    expect(eff).toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
    expect(eff).not.toContain(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    expect(eff).not.toContain('web.run')
    expect(eff).not.toContain('Standalone Web Search')
    expect(eff).toContain('Hosted Web Search')
  })

  it('Standalone 有效指令带 Standalone 标记，且不含任何 Hosted 归因', () => {
    const eff = effectiveInstructions('codex-standalone')
    expect(eff).toContain(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    expect(eff).not.toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
    expect(eff).not.toContain('Hosted Web Search')
    expect(eff).toContain('web.run')
  })

  it('Hosted 自我识别声明「本轮由原生 web_search 执行」，并含 oai-weather 仍属 Hosted', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).toMatch(/native `web_search` tool/)
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain('oai-weather')
    expect(CODEX_SEARCH_INSTRUCTIONS).toMatch(/still Hosted Web Search/i)
  })

  it('每个模式均声明「本轮未执行搜索时不得声称已搜索」', () => {
    expect(CODEX_SEARCH_INSTRUCTIONS).toMatch(/If you performed no web search in this turn, do not claim that you did/i)
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toMatch(/If you performed no web search in this turn, do not claim that you did/i)
  })
})

// ---------------------------------------------------------------------
// 静态守卫：服务层不再注入已删除的 currentSearchMode 声明；各生成路径仍以
// instructions 拼接各自搜索指令（本轮自我识别内嵌其中）。
// ---------------------------------------------------------------------
describe('ChatGPTConversationService 注入点静态守卫', () => {
  const serviceSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/openai/chatgpt/ChatGPTConversationService.ts'),
    'utf8'
  )

  it('不再存在 buildCurrentSearchModeDeclaration 注入（避免同义叠加）', () => {
    expect(serviceSrc).not.toContain('buildCurrentSearchModeDeclaration')
    expect(serviceSrc).not.toContain('currentSearchMode=')
  })

  it('Hosted / Standalone 生成路径均以 instructions 拼接各自搜索指令', () => {
    expect(serviceSrc).toMatch(/const fullInstructions = instructions \+ '\\n\\n' \+ CODEX_SEARCH_INSTRUCTIONS/)
    expect(serviceSrc).toMatch(/const standaloneInstructions = instructions \+ '\\n\\n' \+ CODEX_STANDALONE_SEARCH_INSTRUCTIONS/)
  })
})

// ---------------------------------------------------------------------
// 端到端 wire + 执行事件对应关系：复用真实 ChatGPTCodexAdapter + ToolLoopController。
// 断言「本轮有效指令携带本轮自我识别」与「本轮实际执行的搜索事件」一致。
// ---------------------------------------------------------------------
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

const webSearchDone = (
  id: string,
  sources: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }>
): ResponsesSSEEvent[] => [
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

// Hosted 形态初始请求：systemPrompt 即「本轮最终有效指令」，顶层 hosted web_search。
function hostedRequest(effective: string): CanonicalModelRequest {
  return {
    model: 'gpt-5',
    systemPrompt: effective,
    toolChoice: 'auto',
    tools: [{ name: 'web_search', description: '', parameters: {}, toolType: 'web_search' }],
    messages: [{ role: 'user', content: '刚才用了什么搜索？' }],
  }
}

function hostedController(script: ResponsesSSEEvent[][]) {
  const { client, requests } = recordedClient(script)
  const adapter = new ChatGPTCodexAdapter(client)
  const controller = new ToolLoopController(
    adapter,
    new ToolRegistry(),
    undefined,
    {},
    { maxRounds: 6, replayHostedSearchCalls: true }
  )
  return { controller, requests }
}

const additionalToolNames = (r: ResponsesRequest): Array<string | undefined> =>
  r.input
    .filter((i): i is { type: 'additional_tools'; role: string; tools: unknown[] } => 'type' in i && i.type === 'additional_tools')
    .flatMap((i) => i.tools.map((t) => (t as { name?: string }).name))

// 旧历史（Standalone web.run）——仅存在于历史，本轮不重放
const standaloneHistoryMsg: Message = {
  id: 'm-standalone', conversationId: 'c1', segmentId: 's1', role: 'assistant', content: '旧回答',
  attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
  webSearchResults: null, webSearchError: null, status: 'completed',
  modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
  providerPayloadJson: JSON.stringify({
    provider: 'chatgpt_codex', protocol: 'chatgpt_codex',
    items: [
      { type: 'function_call', call_id: 'run-1', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"旧查询"}]}' },
      { type: 'function_call_output', call_id: 'run-1', output: '旧结果' },
    ],
  }),
  errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
}

// 旧历史（Hosted web_search_call）
const hostedHistoryMsg: Message = {
  id: 'm-hosted', conversationId: 'c1', segmentId: 's1', role: 'assistant', content: '旧回答',
  attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
  webSearchResults: null, webSearchError: null, status: 'completed',
  modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
  providerPayloadJson: JSON.stringify({
    provider: 'chatgpt_codex', protocol: 'chatgpt_codex',
    items: [
      { type: 'web_search_call', id: 'ws-old', status: 'completed', action: { type: 'search', query: '旧查询', sources: [{ url: 'https://old', title: 'Old', type: 'url' }] } },
    ],
  }),
  errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
}

describe('场景 1：旧历史 Standalone × 本轮 Hosted 网页搜索', () => {
  it('wire 指令自我识别为 Hosted；实际执行原生 web_search_call；历史仍被如实解析为 standalone（隔离）', async () => {
    // 历史：旧 Standalone 轮，解析为 standalone（不改写、不删除）
    const resolved = resolveAllSearchProvenance([standaloneHistoryMsg])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ mode: 'standalone', mechanism: 'web.run' })
    const historyCtx = buildAllProvenanceContext(resolved, false)
    expect(historyCtx).toMatch(/mode: standalone/)
    expect(historyCtx).toMatch(/EARLIER turn, NOT the current turn/i)

    // 本轮：Hosted 有效指令
    const eff = effectiveInstructions('codex-hosted')
    const script: ResponsesSSEEvent[][] = [
      [
        created('r1'),
        ...webSearchDone('ws1', [{ url: 'https://a', title: 'A', type: 'url' }]),
        { type: 'response.output_text.delta', delta: '本轮使用 Hosted Web Search' },
        { type: 'response.completed', response: {} },
      ],
    ]
    const { controller, requests } = hostedController(script)

    const completed: Array<{ itemId?: string; sources: number }> = []
    await controller.run(hostedRequest(eff), new AbortController().signal, callbacksWith({
      onWebSearchCall: (ev) => {
        if (ev.phase === 'completed') completed.push({ itemId: ev.itemId, sources: ev.action?.sources?.length ?? 0 })
      },
    }))

    // 有效指令随 wire 下发且自我识别为 Hosted
    expect(requests[0].instructions).toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
    expect(requests[0].instructions).not.toContain('web.run')
    // 实际执行事件：本轮确有 Hosted web_search_call（与自我识别一致）
    expect(completed).toHaveLength(1)
    expect(completed[0].itemId).toBe('ws1')
    expect(completed[0].sources).toBe(1)
    // 本轮 wire 不含 Standalone 的 run；hosted web_search 顶层声明
    expect(additionalToolNames(requests[0])).not.toContain('run')
    expect(requests[0].tools).toEqual([HOSTED_WS_WIRE])
  })
})

describe('场景 2：旧历史 Standalone × 本轮 Hosted oai-weather', () => {
  it('oai-weather 作为 Hosted 来源透传；自我识别明确其为 Hosted 而非 run.weather', async () => {
    const resolved = resolveAllSearchProvenance([standaloneHistoryMsg])
    expect(resolved[0]).toMatchObject({ mode: 'standalone' })

    // 自我识别层：oai-weather 属 Hosted，禁止叙述为 web.run.weather
    const eff = effectiveInstructions('codex-hosted')
    expect(eff).toContain('oai-weather')
    expect(eff).toMatch(/still Hosted Web Search/i)
    // 历史（旧 Standalone）与本轮（Hosted）互不覆盖
    expect(resolveAllSearchProvenance([standaloneHistoryMsg])[0].mode).toBe('standalone')
    expect(eff).toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)

    const script: ResponsesSSEEvent[][] = [
      [
        created('r1'),
        ...webSearchDone('ws-weather', [{ type: 'api', name: 'oai-weather' }]),
        { type: 'response.output_text.delta', delta: '本轮使用 Hosted Web Search（内置 oai-weather 数据源）' },
        { type: 'response.completed', response: {} },
      ],
    ]
    const { controller, requests } = hostedController(script)

    let apiSource: { type?: string; name?: string } | undefined
    await controller.run(hostedRequest(eff), new AbortController().signal, callbacksWith({
      onWebSearchCall: (ev) => {
        if (ev.phase === 'completed') {
          apiSource = ev.action?.sources?.[0] as { type?: string; name?: string }
        }
      },
    }))

    // 实际执行事件：Hosted web_search_call 携带 api 来源，原样保留
    expect(apiSource).toEqual({ type: 'api', name: 'oai-weather' })
    // 本轮 wire 仍是 Hosted（顶层 web_search），不含 run
    expect(requests[0].tools).toEqual([HOSTED_WS_WIRE])
    expect(additionalToolNames(requests[0])).not.toContain('run')
    expect(requests[0].instructions).toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
  })
})

describe('场景 3：旧历史 Hosted × 本轮 Standalone', () => {
  it('历史解析为 hosted；本轮有效指令自我识别为 Standalone，历史不覆盖本轮', () => {
    // 旧历史 Hosted
    const resolved = resolveAllSearchProvenance([hostedHistoryMsg])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ mode: 'hosted', mechanism: 'web_search_call' })
    const historyCtx = buildAllProvenanceContext(resolved, false)
    expect(historyCtx).toMatch(/mode: hosted/)
    expect(historyCtx).toMatch(/EARLIER turn, NOT the current turn/i)

    // 本轮 Standalone 有效指令
    const eff = effectiveInstructions('codex-standalone')
    expect(eff).toContain(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    // 隔离：Standalone 指令不含 Hosted 归因，避免反向污染
    expect(eff).not.toContain('Hosted Web Search')
    expect(eff).not.toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
  })
})

describe('场景 4：当前未执行搜索 → 不得仅凭配置声称执行过搜索', () => {
  it('Hosted 自我识别条件式：无实际 web_search_call 事件则不得声称已搜索', async () => {
    const eff = effectiveInstructions('codex-hosted')
    // 文案层：自我识别声明「未实际执行则不得声称」
    expect(eff).toMatch(/If you performed no web search in this turn, do not claim that you did/i)

    // 执行层：本轮脚本无 web_search_call → 不应有任何 completed 搜索事件
    const script: ResponsesSSEEvent[][] = [finalAnswerScript('直接回答，未联网')]
    const { controller } = hostedController(script)

    const completed: unknown[] = []
    await controller.run(hostedRequest(eff), new AbortController().signal, callbacksWith({
      onWebSearchCall: (ev) => { if (ev.phase === 'completed') completed.push(ev) },
    }))
    expect(completed).toHaveLength(0)
  })
})
