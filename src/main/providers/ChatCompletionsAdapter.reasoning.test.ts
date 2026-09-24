import { describe, it, expect, vi } from 'vitest'

// Adapter 经 httpsClient 间接依赖 electron net/session。本测试只验证 SSE 解析，
// 不发起真实网络请求：mock electron + createRequest。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

// 无状态传输桩：每次 stream() 从 hoisted payloads 读取 SSE 载荷。
// 用普通函数而非 vi.fn()，避免 mock 实现 / 重置生命周期引入的悬挂调用。
const sseStub = vi.hoisted(() => ({ payloads: [] as string[] }))

vi.mock('../openai/chatgpt/httpsClient', () => ({
  createRequest: (_opts: unknown, cb: (res: unknown) => void) => {
    const body = sseStub.payloads.map((p) => `data: ${p}\n\n`).join('')
    const res = {
      statusCode: 200,
      headers: {},
      on(event: string, handler: (chunk?: unknown) => void) {
        if (event === 'data') setTimeout(() => handler(Buffer.from(body)), 0)
        else if (event === 'end') setTimeout(() => handler(), 0)
      },
    }
    setTimeout(() => cb(res), 0)
    return { write: () => {}, end: () => {}, destroy: () => {}, on: () => {} }
  },
}))

import { ChatCompletionsAdapter } from './ChatCompletionsAdapter'
import type { CanonicalModelEvent } from '../../shared/types/provider'

function delta(payload: Record<string, unknown>): string {
  return JSON.stringify({ choices: [{ index: 0, delta: payload }] })
}
function finish(reason: string): string {
  return JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
}

async function collectEvents(payloads: string[]): Promise<CanonicalModelEvent[]> {
  sseStub.payloads = payloads
  const adapter = new ChatCompletionsAdapter({ baseUrl: 'https://x/v1', apiKey: 'k', toolCalling: true })
  const events: CanonicalModelEvent[] = []
  for await (const ev of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(ev)
  }
  return events
}

function summarize(events: CanonicalModelEvent[]): { kinds: string[]; reasoning: string; content: string } {
  let reasoning = ''
  let content = ''
  const kinds: string[] = []
  for (const ev of events) {
    kinds.push(ev.type)
    if (ev.type === 'reasoning_delta') reasoning += ev.text
    if (ev.type === 'delta') content += ev.text
  }
  return { kinds, reasoning, content }
}

describe('ChatCompletionsAdapter — reasoning ingestion', () => {
  it('reasoning_content 流式进入 reasoning，final 进入 content', async () => {
    const events = await collectEvents([
      delta({ role: 'assistant' }),
      delta({ reasoning_content: 'The' }),
      delta({ reasoning_content: ' user' }),
      delta({ content: 'Final' }),
      finish('stop'),
      '[DONE]',
    ])
    const { kinds, reasoning, content } = summarize(events)
    expect(reasoning).toBe('The user')
    expect(content).toBe('Final')
    expect(kinds).toEqual([
      'reasoning_started', 'reasoning_delta', 'reasoning_delta',
      'reasoning_completed', 'delta', 'turn_completed',
    ])
  })

  it('reasoning（vLLM 新字段）流式进入 reasoning', async () => {
    const { reasoning, content } = summarize(await collectEvents([
      delta({ reasoning: 'think-a' }),
      delta({ reasoning: 'think-b', content: 'answer' }),
      finish('stop'),
      '[DONE]',
    ]))
    expect(reasoning).toBe('think-athink-b')
    expect(content).toBe('answer')
  })

  it('raw inline <think> 原样作为正文，无 reasoning 事件（产品边界）', async () => {
    const events = await collectEvents([
      delta({ role: 'assistant' }),
      delta({ content: '<think>abc</think>answer' }),
      finish('stop'),
      '[DONE]',
    ])
    const { kinds, reasoning, content } = summarize(events)
    expect(reasoning).toBe('')
    expect(content).toBe('<think>abc</think>answer')
    expect(kinds).not.toContain('reasoning_started')
    expect(kinds).not.toContain('reasoning_delta')
    expect(kinds).not.toContain('reasoning_completed')
  })

  it('raw inline 跨 chunk 原样拼接（零缓冲）', async () => {
    const { reasoning, content, kinds } = summarize(await collectEvents([
      delta({ content: '<think>The' }),
      delta({ content: ' reasoning</think>Final' }),
      finish('stop'),
      '[DONE]',
    ]))
    expect(reasoning).toBe('')
    expect(content).toBe('<think>The reasoning</think>Final')
    expect(kinds.filter((k) => k === 'delta')).toHaveLength(2)
  })

  it('同一 chunk reasoning_content + content → 两条 canonical 都保留', async () => {
    const events = await collectEvents([
      delta({ reasoning_content: 'think', content: 'answer' }),
      finish('stop'),
      '[DONE]',
    ])
    const { kinds, reasoning, content } = summarize(events)
    expect(reasoning).toBe('think')
    expect(content).toBe('answer')
    expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_completed', 'delta', 'turn_completed'])
  })

  it('仅 stream end（无 finish_reason）→ reasoning 仍 completed，且只一次', async () => {
    const events = await collectEvents([
      delta({ reasoning_content: 'abc' }),
      '[DONE]',
    ])
    const kinds = events.map((e) => e.type)
    expect(kinds.filter((k) => k === 'reasoning_completed')).toHaveLength(1)
    expect(kinds).toContain('turn_completed')
  })

  it('non-streaming message.reasoning / message.content 分流', async () => {
    const messagePayload = JSON.stringify({ choices: [{ index: 0, message: { reasoning: 'think', content: 'answer' }, finish_reason: 'stop' }] })
    const events = await collectEvents([messagePayload, '[DONE]'])
    const { kinds, reasoning, content } = summarize(events)
    expect(reasoning).toBe('think')
    expect(content).toBe('answer')
    expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_completed', 'delta', 'turn_completed'])
  })

  it('non-streaming message.content 含 <think> 原样保留', async () => {
    const messagePayload = JSON.stringify({ choices: [{ index: 0, message: { content: '<think>abc</think>answer' }, finish_reason: 'stop' }] })
    const { reasoning, content } = summarize(await collectEvents([messagePayload, '[DONE]']))
    expect(reasoning).toBe('')
    expect(content).toBe('<think>abc</think>answer')
  })

  it('tool_calls 回归：finish_reason=tool_calls 先收尾 reasoning 再 emit tool_call', async () => {
    const events = await collectEvents([
      delta({ reasoning_content: 'need a tool' }),
      delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'openchat_web_search', arguments: '{"query":"x"}' } }] }),
      finish('tool_calls'),
      '[DONE]',
    ])
    const kinds = events.map((e) => e.type)
    // reasoning 收尾必须早于 tool_call
    expect(kinds.indexOf('reasoning_completed')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('tool_call')).toBeGreaterThan(kinds.indexOf('reasoning_completed'))
    const toolCall = events.find((e) => e.type === 'tool_call')
    expect(toolCall).toMatchObject({ callId: 'call_1', name: 'openchat_web_search' })
    expect(kinds[kinds.length - 1]).toBe('turn_completed')
  })
})
