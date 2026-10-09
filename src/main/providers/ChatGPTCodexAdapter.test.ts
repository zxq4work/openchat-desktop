import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Adapter 经 codexClient 间接依赖 httpsClient 的 electron net/session（仅在真实请求时使用）。
// 本测试只验证 buildRequest 的 reasoning 映射，不发起网络请求。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { ChatGPTCodexAdapter } from './ChatGPTCodexAdapter'
import { buildResponsesHeaders } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import type { CanonicalModelRequest, CanonicalMessage } from '../../shared/types/provider'

// buildRequest 不使用 client；给一个最小桩即可。
const stubClient = {} as ChatGPTCodexClient
const adapter = new ChatGPTCodexAdapter(stubClient)

interface BuiltRequest {
  instructions?: string
  reasoning?: { effort: string; summary?: string; context?: string }
  useResponsesLite?: boolean
  tools?: unknown[]
  include?: string[]
  toolChoice?: unknown
  input: Array<{ type?: string; role?: string; tools?: unknown[] }>
}
interface Buildable { buildRequest(request: CanonicalModelRequest): BuiltRequest }
const build = (req: CanonicalModelRequest) => (adapter as unknown as Buildable).buildRequest(req)

const reqFor = (effort: string | null, lite?: boolean): CanonicalModelRequest => ({
  model: 'gpt-6-astra',
  systemPrompt: '',
  messages: [],
  ...(effort ? { reasoningEffort: effort } : {}),
  ...(lite === undefined ? {} : { responsesLite: lite }),
})

const tool = (name: string, toolType?: string) => ({ name, description: '', parameters: {}, ...(toolType ? { toolType } : {}) })
const hostedWebSearch = () => tool('web_search', 'web_search')
const hostedImageGen = () => tool('image_generation', 'image_generation')

// 期望的最终 wire 形状常量（跨多个 describe 复用）。
const HOSTED_WS_WIRE = { type: 'web_search', search_context_size: 'high' }
const ALLOWED_RUN = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'run' }] }

const additionalTools = (b: BuiltRequest): Array<{ type?: string; name?: string }> =>
  b.input.filter((i) => i.type === 'additional_tools').flatMap((i) => i.tools ?? []) as Array<{ type?: string; name?: string }>

describe('ChatGPTCodexAdapter — reasoning effort 原值透传', () => {
  it('TEST 16: 选择 Extra High → 发送 reasoning.effort = "xhigh"', () => {
    expect(build(reqFor('xhigh')).reasoning?.effort).toBe('xhigh')
  })

  it('TEST 17: 选择 Ultra → 发送 reasoning.effort = "ultra"', () => {
    expect(build(reqFor('ultra')).reasoning?.effort).toBe('ultra')
  })

  it('medium 原值透传（绝不发送 "Medium" 或 description）', () => {
    const effort = build(reqFor('medium')).reasoning?.effort
    expect(effort).toBe('medium')
    expect(effort).not.toBe('Medium')
  })

  it('未来未知 effort 原值透传（future_super_high）', () => {
    expect(build(reqFor('future_super_high')).reasoning?.effort).toBe('future_super_high')
  })

  it('无 reasoningEffort 时不发送 reasoning', () => {
    const req: CanonicalModelRequest = { model: 'gpt-6-astra', systemPrompt: '', messages: [] }
    expect(build(req).reasoning).toBeUndefined()
  })
})

describe('ChatGPTCodexAdapter — Responses Lite reasoning.context', () => {
  it('TEST 18: Responses Lite + medium → header + body context=all_turns', () => {
    const headers = buildResponsesHeaders('tok', 'acct', true)
    expect(headers['x-openai-internal-codex-responses-lite']).toBe('true')

    const body = build(reqFor('medium', true))
    expect(body.useResponsesLite).toBe(true)
    expect(body.reasoning?.effort).toBe('medium')
    expect(body.reasoning?.context).toBe('all_turns')
  })

  it('TEST 19: 非 Lite 模型 → 不发送 Lite header，也不加 context', () => {
    const headers = buildResponsesHeaders('tok', 'acct', false)
    expect(headers['x-openai-internal-codex-responses-lite']).toBeUndefined()

    const body = build(reqFor('medium', false))
    expect(body.useResponsesLite).toBeUndefined()
    expect(body.reasoning?.context).toBeUndefined()
  })

  it('responsesLite 缺省（undefined）→ 不发送 header 与 context', () => {
    const headers = buildResponsesHeaders('tok', 'acct', undefined)
    expect(headers['x-openai-internal-codex-responses-lite']).toBeUndefined()

    const body = build(reqFor('medium'))
    expect(body.reasoning?.context).toBeUndefined()
  })
})

describe('ChatGPTCodexAdapter — Lite tool serialization (P0)', () => {
  it('TEST 13: Lite 纯文本 + searchMode=none → 无 top-level tools', () => {
    const b = build(reqFor('medium', true))
    expect(b.tools).toBeUndefined()
    expect(additionalTools(b)).toEqual([])
  })

  it('TEST 1/11/14: Lite + hosted web_search → 不进入 top-level tools，也不进 additional_tools（Adapter safety 防线）', () => {
    const req = { ...reqFor('medium', true), tools: [hostedWebSearch()], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toBeUndefined()
    expect(b.include).toBeUndefined()
    expect(b.toolChoice).toBe('auto')
    expect(additionalTools(b)).toEqual([])
  })

  it('TEST 2/12: Lite + hosted image_generation → 不进入 top-level tools', () => {
    const req = { ...reqFor('medium', true), tools: [hostedImageGen()], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toBeUndefined()
    expect(additionalTools(b)).toEqual([])
  })

  it('TEST 8: Lite 模型 + codex-standalone 的 run 工具 → 保留于 additional_tools，无 top-level hosted web_search', () => {
    // standalone 搜索不触发 Non-Lite：Lite 模型下 run（function）走 additional_tools。
    const req = { ...reqFor('medium', true), tools: [tool('run')], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.useResponsesLite).toBe(true)
    expect(b.tools).toBeUndefined()
    const at = additionalTools(b)
    expect(at).toHaveLength(1)
    expect(at[0].name).toBe('run')
    expect(at[0].type).toBe('function')
  })

  it('TEST 9: Lite + function tool → 作为 additional_tools 保留，不误删', () => {
    const req = { ...reqFor('medium', true), tools: [tool('openchat_web_search')], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toBeUndefined()
    const at = additionalTools(b)
    expect(at).toHaveLength(1)
    expect(at[0].name).toBe('openchat_web_search')
    expect(at[0].type).toBe('function')
  })

  it('TEST 10: Lite + custom tool → 作为 additional_tools 保留（type=custom）', () => {
    const req = { ...reqFor('medium', true), tools: [tool('my_custom', 'custom')], toolChoice: 'auto' as const }
    const b = build(req)
    const at = additionalTools(b)
    expect(at).toHaveLength(1)
    expect(at[0].type).toBe('custom')
  })

  it('TEST 14: Lite + 未知 tool type → 排除且不发送', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const req = { ...reqFor('medium', true), tools: [tool('weird', 'namespace')], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toBeUndefined()
    expect(additionalTools(b)).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('Lite → adapter 标记 useResponsesLite=true（client 据此注入 parallel_tool_calls=false）', () => {
    expect(build(reqFor('medium', true)).useResponsesLite).toBe(true)
  })
})

describe('ChatGPTCodexAdapter — non-Lite tool serialization 保持不变 (regression)', () => {
  it('TEST 7: non-Lite + hosted web_search → 顶层 tools 含 type=web_search + include', () => {
    const req = { ...reqFor('medium', false), tools: [hostedWebSearch()], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
    expect(b.include).toEqual(['web_search_call.action.sources'])
  })

  it('TEST 8: non-Lite + function tool → 顶层 tools 不含它，作为 additional_tools', () => {
    const req = { ...reqFor('medium', false), tools: [tool('openchat_web_search')], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toBeUndefined()
    const at = additionalTools(b)
    expect(at).toHaveLength(1)
    expect(at[0].name).toBe('openchat_web_search')
  })

  it('non-Lite: toolChoice=required + hosted web_search → 强制 tool_choice={type:web_search}', () => {
    const req = { ...reqFor('medium', false), tools: [hostedWebSearch()], toolChoice: 'required' as const }
    expect(build(req).toolChoice).toEqual({ type: 'web_search' })
  })

  it('TEST 7b: responsesLite=false（codex-hosted 由 Transport Policy 降级）时，Lite 模型恢复 Non-Lite hosted serializer', () => {
    // Transport Policy 对 codex-hosted 把 responsesLite 定为 false；adapter 随之恢复 hosted tools。
    const req = { ...reqFor('medium', false), tools: [hostedWebSearch()], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.useResponsesLite).toBeUndefined()
    expect(b.reasoning?.context).toBeUndefined()
    expect(b.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
    expect(b.include).toEqual(['web_search_call.action.sources'])
  })
})

describe('ChatGPTCodexAdapter — P4 hosted tool 安全（绝不把未实现的 hosted 降级为 function）', () => {
  // OpenChat serializer 仅实现 web_search 的 hosted wire shape。
  // 其余 known hosted 类型（file_search / image_generation / computer_use / code_interpreter）
  // 一旦被错误序列化为 function，就是协议语义降级；必须安全排除（既非 top-level tools，也非 additional_tools）。
  const unimplementedHosted = ['image_generation', 'file_search', 'computer_use', 'code_interpreter'] as const

  it('P4-NonLite-1: Non-Lite + 每个未实现 hosted 类型 → 不出现在任何 tools 通道', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const tt of unimplementedHosted) {
        const req = { ...reqFor('medium', false), tools: [tool(tt, tt)], toolChoice: 'auto' as const }
        const b = build(req)
        expect(b.tools ?? []).toEqual([])
        expect(additionalTools(b)).toEqual([])
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('P4-NonLite-2: Non-Lite + 未实现 hosted 混入正常 function → 仅 function 进 additional_tools', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const req = {
        ...reqFor('medium', false),
        tools: [tool('image_generation', 'image_generation'), tool('openchat_web_search')],
        toolChoice: 'auto' as const,
      }
      const b = build(req)
      expect(b.tools ?? []).toEqual([])
      const at = additionalTools(b)
      expect(at).toHaveLength(1)
      expect(at[0].name).toBe('openchat_web_search')
      expect(at[0].type).toBe('function')
    } finally {
      warn.mockRestore()
    }
  })

  it('P4-NonLite-3: Non-Lite + web_search → 仍为 top-level web_search（已实现路径不变）', () => {
    const req = { ...reqFor('medium', false), tools: [hostedWebSearch()], toolChoice: 'auto' as const }
    expect(build(req).tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
  })

  it('P4-Lite-1: Lite + 每个未实现 hosted 类型 → 一律被排除', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const tt of unimplementedHosted) {
        const req = { ...reqFor('medium', true), tools: [tool(tt, tt)], toolChoice: 'auto' as const }
        const b = build(req)
        expect(b.tools).toBeUndefined()
        expect(additionalTools(b)).toEqual([])
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('P4-NonLite-4: Non-Lite 普通 function（toolType 缺省）行为不变', () => {
    const req = { ...reqFor('medium', false), tools: [tool('openchat_web_search')], toolChoice: 'auto' as const }
    const at = additionalTools(build(req))
    expect(at).toHaveLength(1)
    expect(at[0].type).toBe('function')
  })

  it('P4-Lite-2: Lite 普通 function 行为不变（additional_tools, type=function）', () => {
    const req = { ...reqFor('medium', true), tools: [tool('openchat_web_search')], toolChoice: 'auto' as const }
    const at = additionalTools(build(req))
    expect(at).toHaveLength(1)
    expect(at[0].name).toBe('openchat_web_search')
    expect(at[0].type).toBe('function')
  })

  it('P4-Lite-3: Lite standalone web.run 行为不变（additional_tools）', () => {
    const req = { ...reqFor('medium', true), tools: [tool('run')], toolChoice: 'auto' as const }
    const b = build(req)
    expect(b.tools).toBeUndefined()
    const at = additionalTools(b)
    expect(at).toHaveLength(1)
    expect(at[0].name).toBe('run')
    expect(at[0].type).toBe('function')
  })
})

describe('ChatGPTCodexAdapter — Provider History replay（web_search_call 原样重建）', () => {
  // 历史 hosted web_search_call 以独立 assistant 消息（webSearchCalls）回放为 provider-native wire item。
  const withHistory = (lite?: boolean): CanonicalModelRequest => ({
    ...reqFor('medium', lite),
    messages: [{
      role: 'assistant',
      webSearchCalls: [{
        id: 'ws_1',
        status: 'completed',
        action: { type: 'search', query: 'openai news', sources: [{ url: 'https://a', title: 'A' }] },
      }],
    }],
  })

  // TEST 13：重新开启 hosted（Non-Lite）后，历史 web_search_call 可 restore / replay 为 wire item
  it('TEST 13: Non-Lite 回放历史 web_search_call → input 含 type=web_search_call 且保留 id/action', () => {
    const b = build(withHistory(false))
    const replayed = b.input.filter((i) => i.type === 'web_search_call') as unknown as Array<{ type: string; id: string; action?: { query?: string } }>
    expect(replayed).toHaveLength(1)
    expect(replayed[0].id).toBe('ws_1')
    expect(replayed[0].action?.query).toBe('openai news')
  })
})

describe('ChatGPTCodexAdapter — 历史 web_search_call 原生重放（绝不按 Lite 丢弃）', () => {
  // 设计约束：Hosted → Standalone 跨模式必须保留原生 hosted 历史，不得静默丢弃。
  // 传输决策由 Transport Policy 保证：只要请求含 hosted 历史就 Non-Lite。
  // Adapter 层对 web_search_call 一律原样重建（含 id/status/action/sources），
  // 不因 responsesLite 旗标丢弃历史——避免 adapter 成为跨模式历史丢失点。
  const hostedHistory = (): CanonicalMessage[] => [
    { role: 'user', content: '搜索 OpenAI 最新消息' },
    { role: 'assistant', webSearchCalls: [{
      id: 'ws_hist_1',
      status: 'completed',
      action: { type: 'search', query: 'openai news', sources: [{ url: 'https://a', title: 'A' }, { url: 'https://b', title: 'B' }] },
    }] },
    { role: 'assistant', content: '这是上一轮 Hosted 搜索结果摘要。' },
  ]

  it('Lock: responsesLite=true 时 Adapter 仍原样重放 web_search_call（丢弃点不在此层）', () => {
    const req: CanonicalModelRequest = { ...reqFor('low', true), messages: hostedHistory() }
    const b = build(req)
    const replayed = b.input.filter((i) => i.type === 'web_search_call') as unknown as Array<{ id: string; status?: string; action?: { query?: string; sources?: unknown[] } }>
    expect(replayed).toHaveLength(1)
    expect(replayed[0].id).toBe('ws_hist_1')
    expect(replayed[0].status).toBe('completed')
    expect(replayed[0].action?.query).toBe('openai news')
    // 来源数据完整保留
    expect(replayed[0].action?.sources).toHaveLength(2)
  })

  it('Standalone 形态（run 工具 + hosted 历史）→ web_search_call 与 additional_tools 共存', () => {
    const req: CanonicalModelRequest = { ...reqFor('low', true), tools: [tool('run')], toolChoice: 'auto', messages: hostedHistory() }
    const b = build(req)
    expect(b.input.filter((i) => i.type === 'web_search_call')).toHaveLength(1)
    expect(additionalTools(b).map((t) => t.name)).toEqual(['run'])
    // 助手文本历史不丢失
    expect(b.input.some((i) => (i as { role?: string }).role === 'assistant' && (i as { content?: string }).content)).toBe(true)
  })

  it('场景 A: Standalone function_call + Hosted web_search_call 混合历史（Non-Lite）→ 全部按序保留', () => {
    // Standalone Lite 阶段产生的 function_call/function_call_output + Hosted 阶段的 web_search_call
    // 必须能同时、按原始顺序重放（Hosted→Standalone 走 Non-Lite）。
    const mixed: CanonicalMessage[] = [
      { role: 'user', content: 'standalone 搜索' },
      { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"x"}]}' }] },
      { role: 'tool', content: '{"output":"standalone result"}', toolResult: { callId: 'call_1', name: 'run', output: '{"output":"standalone result"}' } },
      { role: 'assistant', content: 'standalone 回答' },
      { role: 'user', content: 'hosted 搜索' },
      { role: 'assistant', webSearchCalls: [{ id: 'ws_a', status: 'completed', action: { type: 'search', query: 'y', sources: [{ url: 'https://a' }] } }] },
      { role: 'assistant', content: 'hosted 回答' },
    ]
    const req: CanonicalModelRequest = { ...reqFor('low', false), tools: [tool('run')], toolChoice: 'auto', messages: mixed }
    const b = build(req)
    const types = b.input.map((i) => (i as { type?: string }).type ?? (i as { role?: string }).role)
    // additional_tools 在最前（run 声明），随后按序：user, function_call, function_call_output, assistant, user, web_search_call, assistant
    expect(types).toEqual(['additional_tools', 'user', 'function_call', 'function_call_output', 'assistant', 'user', 'web_search_call', 'assistant'])
    const fc = b.input.find((i) => (i as { type?: string }).type === 'function_call') as { call_id?: string; namespace?: string; name?: string }
    expect(fc.call_id).toBe('call_1')
    expect(fc.namespace).toBe('web')
    expect(fc.name).toBe('run')
    const fco = b.input.find((i) => (i as { type?: string }).type === 'function_call_output') as { call_id?: string }
    expect(fco.call_id).toBe('call_1')
  })
})

describe('ChatGPTCodexAdapter — 跨模式历史兼容（Standalone 重放 Hosted 历史，最终 wire）', () => {
  // 复现场景：Non-Lite standalone + 本地 run 工具（ToolLoop 正常轮）+ 历史 hosted web_search_call。
  const standaloneRunRoundWithHostedHistory = (): CanonicalModelRequest => ({
    ...reqFor('low', false),
    tools: [tool('run')],
    toolChoice: 'auto',
    messages: [
      { role: 'user', content: 'hosted 搜索' },
      { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } }] },
      { role: 'assistant', content: '历史回答' },
      { role: 'user', content: '本轮问题' },
    ],
  })

  it('Standalone 正常轮 + hosted 历史 → 补顶层 web_search；toolChoice=allowed_tools(run)；无 include', () => {
    const b = build(standaloneRunRoundWithHostedHistory())
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
    expect(b.include).toBeUndefined()
    expect(b.toolChoice).toEqual(ALLOWED_RUN)
    // 历史完整保留、run 工具仍在
    expect(b.input.filter((i) => i.type === 'web_search_call')).toHaveLength(1)
    expect(additionalTools(b).map((t) => t.name)).toEqual(['run'])
    // 不切换传输模式（仍由 Transport Policy 决定，adapter 不越权）
    expect(b.useResponsesLite).toBeUndefined()
  })

  it('优先：hosted 历史 + 声明 run + toolChoice=auto → allowed_tools(run)', () => {
    const b = build(standaloneRunRoundWithHostedHistory()) // toolChoice: 'auto'
    expect(additionalTools(b).map((t) => t.name)).toEqual(['run'])
    expect(b.toolChoice).toEqual(ALLOWED_RUN)
  })

  it('优先：hosted 历史 + 声明 run + toolChoice=none → 必须保持 none（绝不被覆盖为 allowed_tools）', () => {
    const b = build({ ...standaloneRunRoundWithHostedHistory(), toolChoice: 'none' })
    // run 仍在 input 中（历史兼容不改 input），但调用方明确禁止工具 → 不得重新放开 run 执行
    expect(additionalTools(b).map((t) => t.name)).toEqual(['run'])
    expect(b.toolChoice).toBe('none')
    // 兼容声明与历史仍完整保留
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
    expect(b.include).toBeUndefined()
    expect(b.input.filter((i) => i.type === 'web_search_call')).toHaveLength(1)
  })

  it('优先：hosted 历史 + 未声明 run → none（即便 toolChoice=auto 也不放开工具）', () => {
    const b = build({
      ...reqFor('low', false),
      toolChoice: 'auto',
      messages: [
        { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } }] },
        { role: 'user', content: '本轮问题' },
      ],
    })
    expect(additionalTools(b)).toEqual([])
    expect(b.toolChoice).toBe('none')
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
  })

  it('优先：普通 Standalone（无 hosted 历史）+ 声明 run + toolChoice=none → none（行为不变）', () => {
    const b = build({
      ...reqFor('low', false),
      tools: [tool('run')],
      toolChoice: 'none',
      messages: [{ role: 'user', content: '普通 standalone 问题' }],
    })
    expect(b.tools).toBeUndefined()
    expect(b.toolChoice).toBe('none')
    expect(additionalTools(b).map((t) => t.name)).toEqual(['run'])
  })

  it('收尾轮（无 run 声明）+ hosted 历史 → toolChoice=none（禁用所有新工具），仍保留顶层 web_search 与历史', () => {
    // ToolLoop 的收尾请求 = {...initialRequest, messages}，不注入 registryTools，故无 additional_tools(run)。
    const wrapUp: CanonicalModelRequest = {
      ...reqFor('low', false),
      messages: [
        { role: 'user', content: 'hosted 搜索' },
        { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } }] },
        { role: 'user', content: 'Please provide your final answer now. Do not use any tools.' },
      ],
    }
    const b = build(wrapUp)
    expect(additionalTools(b)).toEqual([])
    expect(b.toolChoice).toBe('none')
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
    expect(b.input.filter((i) => i.type === 'web_search_call')).toHaveLength(1)
  })

  it('normal round 与 wrap-up 的唯一 wire 差异 = tool_choice（其余逐字段相等）', () => {
    const normal = build(standaloneRunRoundWithHostedHistory())
    const wrapUp: CanonicalModelRequest = {
      ...reqFor('low', false),
      messages: [
        { role: 'user', content: 'hosted 搜索' },
        { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } }] },
        { role: 'user', content: '本轮问题' },
      ],
    }
    const w = build(wrapUp)
    expect(normal.tools).toEqual(w.tools)          // 都是顶层 web_search
    expect(normal.include).toEqual(w.include)      // 都无 include
    expect(normal.input.filter((i) => i.type === 'web_search_call').length)
      .toBe(w.input.filter((i) => i.type === 'web_search_call').length)
    expect(normal.toolChoice).toEqual(ALLOWED_RUN)
    expect(w.toolChoice).toBe('none')
  })

  it('无 hosted 历史 + run 工具（普通 Standalone）→ 不注入顶层 web_search，tool_choice 保持 auto（行为不变）', () => {
    const b = build({
      ...reqFor('low', false),
      tools: [tool('run')],
      toolChoice: 'auto',
      messages: [{ role: 'user', content: '普通 standalone 问题' }],
    })
    expect(b.tools).toBeUndefined()
    expect(b.toolChoice).toBe('auto')
    expect(additionalTools(b).map((t) => t.name)).toEqual(['run'])
  })

  it('Hosted 路径（显式 web_search 工具声明）→ 顶层 web_search + include，tool_choice=auto（行为不变）', () => {
    const b = build({
      ...reqFor('low', false),
      tools: [hostedWebSearch()],
      toolChoice: 'auto',
      messages: [{ role: 'user', content: 'hosted 搜索' }],
    })
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
    expect(b.include).toEqual(['web_search_call.action.sources'])
    expect(b.toolChoice).toBe('auto')
  })

  it('Lite 请求绝不因历史兼容注入顶层 web_search（Lite 不走桥）', () => {
    const b = build({
      ...reqFor('low', true),
      messages: [
        { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q' } }] },
        { role: 'user', content: 'x' },
      ],
    })
    expect(b.tools).toBeUndefined()
    expect(b.useResponsesLite).toBe(true)
  })

  it('混合历史：standalone function_call/output + hosted web_search_call（Non-Lite）→ 全部按序保留 + 兼容桥生效', () => {
    const mixed: CanonicalMessage[] = [
      { role: 'user', content: 'standalone 搜索' },
      { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"x"}]}' }] },
      { role: 'tool', content: '{"output":"standalone result"}', toolResult: { callId: 'call_1', name: 'run', output: '{"output":"standalone result"}' } },
      { role: 'assistant', content: 'standalone 回答' },
      { role: 'user', content: 'hosted 搜索' },
      { role: 'assistant', webSearchCalls: [{ id: 'ws_a', status: 'completed', action: { type: 'search', query: 'y', sources: [{ url: 'https://a' }] } }] },
      { role: 'assistant', content: 'hosted 回答' },
      { role: 'user', content: '本轮问题' },
    ]
    const b = build({ ...reqFor('low', false), tools: [tool('run')], toolChoice: 'auto', messages: mixed })
    const types = b.input.map((i) => (i as { type?: string }).type ?? (i as { role?: string }).role)
    expect(types).toEqual(['additional_tools', 'user', 'function_call', 'function_call_output', 'assistant', 'user', 'web_search_call', 'assistant', 'user'])
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
    expect(b.toolChoice).toEqual(ALLOWED_RUN)
  })
})

describe('ChatGPTCodexAdapter — hosted web_search 工具声明不触发 include 的回归（原 hosted 路径不变）', () => {
  it('仅当声明 hosted web_search 工具时才带 include（历史兼容桥不带 include）', () => {
    const hostedOnly = build({ ...reqFor('low', false), tools: [hostedWebSearch()], toolChoice: 'auto', messages: [] })
    expect(hostedOnly.include).toEqual(['web_search_call.action.sources'])
    const bridge = build({
      ...reqFor('low', false),
      tools: [tool('run')],
      toolChoice: 'auto',
      messages: [{ role: 'assistant', webSearchCalls: [{ id: 'w', status: 'completed', action: { type: 'search', query: 'q' } }] }],
    })
    expect(bridge.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
    expect(bridge.include).toBeUndefined()
  })

  it('历史兼容桥绝不注入 include（sources 仅在历史中，不需重新抓取）', () => {
    const b = build({
      ...reqFor('low', false),
      tools: [tool('run')],
      toolChoice: 'auto',
      messages: [
        { role: 'assistant', webSearchCalls: [{ id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } }] },
        { role: 'user', content: '本轮问题' },
      ],
    })
    expect(b.tools).toEqual([HOSTED_WS_WIRE])
    expect(b.include).toBeUndefined()
  })
})

// 静态护栏：跨模式协议修复的硬约束，防止后续改动静默回退。
// 断言前剥离注释，避免注释文字造成误判。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
const rootSrc = (rel: string): string => stripComments(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8'))

describe('ChatGPTCodexAdapter — 跨模式协议静态护栏', () => {
  const adapterSrc = rootSrc('src/main/providers/ChatGPTCodexAdapter.ts')
  const serviceSrc = rootSrc('src/main/openai/chatgpt/ChatGPTConversationService.ts')

  it('adapter 的历史兼容桥按调用方意图优先：toolChoice=none 或未声明 run → none，否则 allowed_tools(run)', () => {
    // 桥场景 tool_choice 存在三种输入（'none' / 未声明 run / 声明 run 且未禁止），
    // 结果只能是 'none' 或 allowed_tools(run)，无 auto 回退、也无对 'none' 的覆盖。
    expect(adapterSrc).toMatch(/request\.toolChoice\s*===\s*'none'/)
    expect(adapterSrc).toMatch(/!requestDeclaresRun\(input\)/)
    expect(adapterSrc).toMatch(/CODEX_ALLOWED_TOOLS_RUN/)
  })

  it('adapter 的跨模式桥仅在「重放 hosted 历史且未声明 web_search」时生效', () => {
    expect(adapterSrc).toMatch(/replaysHostedHistory/)
    expect(adapterSrc).toMatch(/declaresHostedWebSearch/)
    expect(adapterSrc).toMatch(/needsHostedHistoryBridge\s*=\s*replaysHostedHistory\s*&&\s*!declaresHostedWebSearch/)
  })

  it('Standalone 路径挂接意外 hosted 搜索兜底：抛出 CodexProtocolIsolationError（绝不静默）', () => {
    // onWebSearchCall 必须存在且抛出隔离异常。
    expect(serviceSrc).toMatch(/onWebSearchCall:/)
    expect(serviceSrc).toMatch(/throw new CodexProtocolIsolationError\(\)/)
    // 该异常必须进入统一错误结束分支（updateError + emitStreamEvent error）。
    expect(serviceSrc).toMatch(/CodexProtocolIsolationError/)
    expect(serviceSrc).toMatch(/CODEX_HOSTED_SEARCH_LEAKED|err\.code/)
  })

  it('隔离异常通过 finally 释放 activeGeneration（后续发送不被卡死）', () => {
    // runGeneration 的 finally 必须清空 activeGeneration。
    expect(serviceSrc).toMatch(/this\.activeGeneration\s*=\s*null/)
  })
})

