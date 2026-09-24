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

import { ResponsesAdapter } from './ResponsesAdapter'
import type { CanonicalModelEvent } from '../../shared/types/provider'

async function collectEvents(payloads: string[]): Promise<CanonicalModelEvent[]> {
  sseStub.payloads = payloads
  const adapter = new ResponsesAdapter({ baseUrl: 'https://x/v1', apiKey: 'k', toolCalling: true })
  const events: CanonicalModelEvent[] = []
  for await (const ev of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev)
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

describe('ResponsesAdapter — reasoning summary 分流', () => {
  it('reasoning_summary_text.delta → reasoning，output_text.delta → content', async () => {
    const events = await collectEvents([
      JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
      JSON.stringify({ type: 'response.reasoning_summary_part.added', item_id: 'rs_1' }),
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: '思考' }),
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: '过程' }),
      JSON.stringify({ type: 'response.reasoning_summary_text.done', item_id: 'rs_1' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: '答案' }),
      JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', output: [] } }),
      '[DONE]',
    ])
    const { kinds, reasoning, content } = summarize(events)
    expect(reasoning).toBe('思考过程')
    expect(content).toBe('答案')
    expect(kinds).toContain('reasoning_started')
    expect(kinds).toContain('reasoning_completed')
    expect(kinds).toContain('delta')
    expect(kinds).toContain('turn_completed')
  })

  it('reasoning_text.delta（原始 CoT）同样进入 reasoning', async () => {
    const { reasoning, content } = summarize(await collectEvents([
      JSON.stringify({ type: 'response.reasoning_text.delta', item_id: 'rt_1', delta: 'raw cot' }),
      JSON.stringify({ type: 'response.reasoning_text.done', item_id: 'rt_1' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'final' }),
      JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [] } }),
      '[DONE]',
    ]))
    expect(reasoning).toBe('raw cot')
    expect(content).toBe('final')
  })

  it('output_text 中含 <think> 不被 ResponsesAdapter 当作 reasoning（不做 inline fallback）', async () => {
    const { reasoning, content } = summarize(await collectEvents([
      JSON.stringify({ type: 'response.output_text.delta', delta: '<think>literal</think>answer' }),
      JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [] } }),
      '[DONE]',
    ]))
    expect(reasoning).toBe('')
    expect(content).toBe('<think>literal</think>answer')
  })
})
