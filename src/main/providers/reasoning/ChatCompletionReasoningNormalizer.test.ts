import { describe, it, expect } from 'vitest'
import { ChatCompletionReasoningNormalizer, type ReasoningNormalizeEvent } from './ChatCompletionReasoningNormalizer'
import { extractStructuredReasoning, findUnknownReasoningLikeField } from './reasoningExtraction'

// 把某个 delta 序列跑完，收集全部 canonical 事件（含 finalize 收尾）
function run(chunks: Array<Record<string, unknown>>, closeBy?: 'finish_reason' | 'stream_end'): ReasoningNormalizeEvent[] {
  const n = new ChatCompletionReasoningNormalizer()
  const events: ReasoningNormalizeEvent[] = []
  for (const c of chunks) events.push(...n.process(c))
  events.push(...n.finalize(closeBy ? { closedBy: closeBy } : undefined))
  return events
}

// 从事件序列还原 reasoning / content 文本（用于断言最终分流结果）
function collect(events: ReasoningNormalizeEvent[]): { reasoning: string; content: string; kinds: string[] } {
  let reasoning = ''
  let content = ''
  const kinds: string[] = []
  for (const ev of events) {
    kinds.push(ev.type)
    if (ev.type === 'reasoning_delta') reasoning += ev.text
    else if (ev.type === 'delta') content += ev.text
  }
  return { reasoning, content, kinds }
}

describe('reasoningExtraction', () => {
  it('识别 reasoning（vLLM 现任字段）', () => {
    expect(extractStructuredReasoning({ reasoning: 'abc' })).toEqual({ text: 'abc', source: 'reasoning', multipleStructuredReasoningFields: false })
  })

  it('识别 reasoning_content（Qwen/DeepSeek/GLM）', () => {
    expect(extractStructuredReasoning({ reasoning_content: 'abc' })).toEqual({ text: 'abc', source: 'reasoning_content', multipleStructuredReasoningFields: false })
  })

  it('双字段同时出现 → 只取一个（reasoning 优先）', () => {
    const r = extractStructuredReasoning({ reasoning: 'X', reasoning_content: 'Y' })
    expect(r.source).toBe('reasoning')
    expect(r.text).toBe('X')
  })

  it('双字段值相同 → 不标记 multiple', () => {
    const r = extractStructuredReasoning({ reasoning: 'same', reasoning_content: 'same' })
    expect(r.multipleStructuredReasoningFields).toBe(false)
  })

  it('空字符串 / 非字符串不算命中', () => {
    expect(extractStructuredReasoning({ reasoning: '', reasoning_content: 'ok' }).source).toBe('reasoning_content')
    expect(extractStructuredReasoning({ reasoning: 123 }).source).toBeNull()
  })

  it('未知 reasoning-like key 被识别为 unknown（不解析）', () => {
    expect(findUnknownReasoningLikeField(['chain_of_thought'])).toBe('chain_of_thought')
    expect(findUnknownReasoningLikeField(['scratchpad'])).toBe('scratchpad')
  })

  it('已知字段不算 unknown', () => {
    expect(findUnknownReasoningLikeField(['reasoning', 'reasoning_content'])).toBeNull()
    expect(findUnknownReasoningLikeField(['reasoning_details'])).toBeNull()
  })
})

describe('ChatCompletionReasoningNormalizer — structured streaming', () => {
  it('TEST 1: reasoning_content 流式 → started / delta / completed + final content', () => {
    const events = run([
      { role: 'assistant' },
      { reasoning_content: 'abc' },
      { reasoning_content: 'def' },
      { content: 'answer' },
    ])
    const { reasoning, content, kinds } = collect(events)
    expect(reasoning).toBe('abcdef')
    expect(content).toBe('answer')
    expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_delta', 'reasoning_completed', 'delta'])
  })

  it('TEST 2: reasoning（vLLM 新字段）流式 → 同样分流', () => {
    const { reasoning, content } = collect(run([
      { reasoning: 'abc' },
      { reasoning: 'def' },
      { content: 'answer' },
    ]))
    expect(reasoning).toBe('abcdef')
    expect(content).toBe('answer')
  })

  it('TEST 3: same chunk reasoning + content → START/DELTA/COMPLETED/CHAT_DELTA', () => {
    const events = run([{ reasoning: 'abc', content: 'answer' }])
    const { reasoning, content, kinds } = collect(events)
    expect(reasoning).toBe('abc')
    expect(content).toBe('answer')
    expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_completed', 'delta'])
  })

  it('TEST 4: same chunk reasoning_content + content → 同样顺序', () => {
    const events = run([{ reasoning_content: 'abc', content: 'answer' }])
    const { reasoning, content, kinds } = collect(events)
    expect(reasoning).toBe('abc')
    expect(content).toBe('answer')
    expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_completed', 'delta'])
  })

  it('TEST 5: dual field 同值 → 只 append 一次', () => {
    const { reasoning } = collect(run([
      { reasoning: 'abc', reasoning_content: 'abc' },
      { content: 'answer' },
    ]))
    expect(reasoning).toBe('abc')
  })

  it('TEST 6: dual field 不同值 → 只取 reasoning，不拼接', () => {
    const { reasoning } = collect(run([
      { reasoning: 'abc', reasoning_content: 'xyz' },
      { content: 'answer' },
    ]))
    expect(reasoning).toBe('abc')
  })

  it('TEST 7: reasoning-only + finish_reason → completed，content 为空', () => {
    const events = run([{ reasoning: 'just thinking' }], 'finish_reason')
    const { reasoning, content, kinds } = collect(events)
    expect(reasoning).toBe('just thinking')
    expect(content).toBe('')
    expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_completed'])
  })

  it('TEST 8: final 后 late structured reasoning → 不回退 visible reasoning', () => {
    const { reasoning, content, kinds } = collect(run([
      { content: 'answer' },
      { reasoning: 'late' },
    ]))
    expect(content).toBe('answer')
    expect(reasoning).toBe('')
    expect(kinds).toEqual(['delta'])
  })

  it('TEST 9: raw inline <think> 原样进入 content，无任何 reasoning 事件', () => {
    const { reasoning, content, kinds } = collect(run([
      { content: '<think>abc</think>answer' },
    ]))
    expect(reasoning).toBe('')
    expect(content).toBe('<think>abc</think>answer')
    expect(kinds).toEqual(['delta'])
  })

  it('raw inline 跨 chunk 也原样拼接，不缓冲不拆分', () => {
    const n = new ChatCompletionReasoningNormalizer()
    const e1 = collect(n.process({ content: '<thi' }))
    expect(e1.content).toBe('<thi')
    expect(e1.kinds).toEqual(['delta'])
    const e2 = collect(n.process({ content: 'nk>abc</think>answer' }))
    expect(e2.content).toBe('nk>abc</think>answer')
    expect(e2.kinds).toEqual(['delta'])
    expect(collect(n.finalize({ closedBy: 'stream_end' })).kinds).toEqual([])
  })

  it('普通正文含 <think> 不被特殊处理', () => {
    const { reasoning, content } = collect(run([
      { content: 'HTML 中的 <think> 标签不是标准标签。' },
      { content: '更多说明' },
    ]))
    expect(reasoning).toBe('')
    expect(content).toBe('HTML 中的 <think> 标签不是标准标签。更多说明')
  })

  it('usage.reasoning_tokens 不产生任何 reasoning 事件', () => {
    const events = run([
      { content: 'answer' },
      { usage: { reasoning_tokens: 1000 } },
    ])
    const { reasoning, content, kinds } = collect(events)
    expect(reasoning).toBe('')
    expect(content).toBe('answer')
    expect(kinds).toEqual(['delta'])
  })

  it('未知 reasoning-like key（chain_of_thought）不进入 reasoning', () => {
    const { reasoning, content } = collect(run([
      { chain_of_thought: 'secret', content: 'answer' },
    ]))
    expect(reasoning).toBe('')
    expect(content).toBe('answer')
  })

  it('reasoning_started 整轮只 emit 一次', () => {
    const kinds = run([
      { reasoning: 'a' },
      { reasoning: 'b' },
      { reasoning: 'c' },
    ]).map((e) => e.type)
    expect(kinds.filter((k) => k === 'reasoning_started')).toHaveLength(1)
  })
})

describe('ChatCompletionReasoningNormalizer — finalize 幂等', () => {
  it('finish_reason finalize + stream-end finalize → reasoning_completed 只一次', () => {
    const n = new ChatCompletionReasoningNormalizer()
    const events: ReasoningNormalizeEvent[] = []
    events.push(...n.process({ reasoning: 'abc' }))
    events.push(...n.finalize({ closedBy: 'finish_reason' }))
    events.push(...n.finalize({ closedBy: 'stream_end' }))
    const { kinds } = collect(events)
    expect(kinds.filter((k) => k === 'reasoning_completed')).toHaveLength(1)
  })

  it('content 已提前 close 后再 finalize → 不再重复 reasoning_completed', () => {
    const n = new ChatCompletionReasoningNormalizer()
    const events: ReasoningNormalizeEvent[] = []
    events.push(...n.process({ reasoning: 'abc', content: 'answer' }))
    events.push(...n.finalize({ closedBy: 'stream_end' }))
    const { kinds, content } = collect(events)
    expect(kinds.filter((k) => k === 'reasoning_completed')).toHaveLength(1)
    expect(content).toBe('answer')
  })
})

describe('ChatCompletionReasoningNormalizer — 并发隔离', () => {
  it('两个实例状态互不影响', () => {
    const a = new ChatCompletionReasoningNormalizer()
    const b = new ChatCompletionReasoningNormalizer()
    const aEvents = a.process({ reasoning: 'aaa' })
    b.process({ content: 'plain b' })
    const bEvents = b.process({ content: ' more' })
    const { content } = collect(bEvents)
    expect(content).toBe(' more')
    aEvents.push(...a.finalize({ closedBy: 'stream_end' }))
    const aCollected = collect(aEvents)
    expect(aCollected.reasoning).toBe('aaa')
  })
})
