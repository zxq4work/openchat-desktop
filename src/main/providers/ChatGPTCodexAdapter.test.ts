import { describe, it, expect, vi } from 'vitest'

// Adapter 经 codexClient 间接依赖 httpsClient 的 electron net/session（仅在真实请求时使用）。
// 本测试只验证 buildRequest 的 reasoning 映射，不发起网络请求。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { ChatGPTCodexAdapter } from './ChatGPTCodexAdapter'
import { buildResponsesHeaders } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import type { CanonicalModelRequest } from '../../shared/types/provider'

// buildRequest 不使用 client；给一个最小桩即可。
const stubClient = {} as ChatGPTCodexClient
const adapter = new ChatGPTCodexAdapter(stubClient)

interface BuiltRequest {
  reasoning?: { effort: string; summary?: string; context?: string }
  useResponsesLite?: boolean
  tools?: unknown[]
  include?: string[]
  toolChoice?: string | { type: string }
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
