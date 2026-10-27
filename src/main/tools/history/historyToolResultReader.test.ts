import { describe, it, expect } from 'vitest'
import type { Message } from '../../../shared/types/conversation'
import { collectHistoryToolCalls, readHistoryCallChunk } from './historyToolResultReader'

// 构造最小 Message fixture（只填 reader 用到的字段，其余给安全默认值）。
function makeAssistantMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm1', conversationId: 'c1', segmentId: 's1', role: 'assistant', content: '',
    attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
    webSearchResults: null, webSearchError: null, status: 'completed',
    modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
    providerPayloadJson: null, errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

function toolPayload(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ provider: 'chatgpt_codex', protocol: 'chatgpt_codex', items })
}

describe('historyToolResultReader — 读取真实已持久化历史', () => {
  it('解析 function_call/function_call_output 配对，outputLength 为真实长度', () => {
    const longOutput = 'A'.repeat(12640)
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'function_call', call_id: 'call-1', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"x"}]}' },
        { type: 'function_call_output', call_id: 'call-1', output: longOutput },
      ]),
    })
    const calls = collectHistoryToolCalls([msg])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ callId: 'call-1', kind: 'tool', name: 'run', namespace: 'web', outputLength: 12640, isError: false })
  })

  it('hosted web_search_call 归一为 kind=hosted_search，无正文；callSourceCount=自身 sources，messageSourceCount=消息聚合', () => {
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } },
      ]),
      webSearchResults: [
        { title: 'A', url: 'https://a.example', snippet: 'S', sourceType: 'web' },
      ],
    })
    const calls = collectHistoryToolCalls([msg])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ callId: 'ws1', kind: 'hosted_search', name: 'web_search', outputLength: 0, callSourceCount: 1, messageSourceCount: 1 })
  })

  it('client tool 的 callSourceCount=null（持久化未保存按调用来源），messageSourceCount=消息聚合', () => {
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'function_call', call_id: 'call-x', name: 'run', namespace: 'web', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-x', output: 'ok' },
      ]),
      // 整条消息聚合了 13 条来源（12 web + 1 api），但不属于单次调用。
      webSearchResults: [
        ...Array.from({ length: 12 }, (_, i) => ({ title: `W${i}`, url: `https://w${i}.example`, snippet: null, sourceType: 'web' as const })),
        { title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' as const },
      ],
    })
    const calls = collectHistoryToolCalls([msg])
    expect(calls[0].callSourceCount).toBeNull()
    expect(calls[0].messageSourceCount).toBe(13)
  })

  it('readHistoryCallChunk：callSources=null 时不冒充，messageSources 独立返回', () => {
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'function_call', call_id: 'call-y', name: 'run', namespace: 'web', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-y', output: 'body' },
      ]),
      webSearchResults: [{ title: 'W', url: 'https://w.example', snippet: null, sourceType: 'web' }],
    })
    const chunk = readHistoryCallChunk([msg], 'call-y', 0, 4000)
    expect(chunk?.callSources).toBeNull()
    expect(chunk?.messageSources).toHaveLength(1)
  })

  it('12640 字符 output 可分页连续读完，拼接等于原文', () => {
    const longOutput = Array.from({ length: 12640 }, (_, i) => String(i % 10)).join('')
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'function_call', call_id: 'call-long', name: 'run', namespace: 'web', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-long', output: longOutput },
      ]),
    })
    let offset = 0
    let acc = ''
    let guard = 0
    for (;;) {
      const chunk = readHistoryCallChunk([msg], 'call-long', offset, 4000)
      expect(chunk).not.toBeNull()
      expect(chunk!.content).toBe(longOutput.slice(offset, offset + 4000))
      acc += chunk!.content
      if (!chunk!.hasMore) {
        expect(chunk!.nextOffset).toBeNull()
        break
      }
      expect(chunk!.nextOffset).toBe(offset + 4000)
      offset = chunk!.nextOffset!
      if (++guard > 10) throw new Error('paging did not terminate')
    }
    expect(acc).toBe(longOutput)
    expect(acc.length).toBe(12640)
  })

  it('不存在的 callId 返回 null（绝不返回空串成功）', () => {
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'function_call', call_id: 'x', name: 'run', arguments: '{}' },
        { type: 'function_call_output', call_id: 'x', output: 'hello' },
      ]),
    })
    expect(readHistoryCallChunk([msg], 'nope', 0, 4000)).toBeNull()
  })

  it('错误 output 标记 isError', () => {
    const msg = makeAssistantMessage({
      providerPayloadJson: toolPayload([
        { type: 'function_call', call_id: 'e1', name: 'run', namespace: 'web', arguments: '{}' },
        { type: 'function_call_output', call_id: 'e1', output: 'Error: Max web.run calls per turn reached' },
      ]),
    })
    expect(collectHistoryToolCalls([msg])[0].isError).toBe(true)
  })
})
