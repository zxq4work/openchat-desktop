import { describe, it, expect } from 'vitest'
import type { Message } from '../../../shared/types/conversation'
import { ReadHistoryTool } from './ReadHistoryTool'

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

function payload(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ provider: 'chatgpt_codex', protocol: 'chatgpt_codex', items })
}

const msg = makeAssistantMessage({
  providerPayloadJson: payload([
    { type: 'function_call', call_id: 'call-1', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"天气"}]}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'X'.repeat(9000) },
  ]),
  webSearchResults: [{ title: 'A', url: 'https://a.example', snippet: 'S', sourceType: 'web' }],
})

const ctx = {}

describe('ReadHistoryTool — 统一只读历史访问', () => {
  it('list 返回可用调用（含 callId、真实 outputLength、来源计数），且不含正文', async () => {
    const tool = new ReadHistoryTool([msg])
    const res = await tool.execute({ action: 'list' }, ctx)
    const body = JSON.parse(res.output)
    expect(body.count).toBe(1)
    expect(body.calls[0]).toMatchObject({ callId: 'call-1', kind: 'tool', name: 'run', outputLength: 9000, callSourceCount: null, messageSourceCount: 1 })
    expect(body.calls[0].content).toBeUndefined()
  })

  it('read 返回真实正文并按 nextOffset 连续读到结尾', async () => {
    const tool = new ReadHistoryTool([msg])
    const first = JSON.parse((await tool.execute({ action: 'read', callId: 'call-1', limit: 4000 }, ctx)).output)
    expect(first.returnedLength).toBe(4000)
    expect(first.totalLength).toBe(9000)
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(4000)

    const second = JSON.parse((await tool.execute({ action: 'read', callId: 'call-1', offset: 4000, limit: 4000 }, ctx)).output)
    expect(second.returnedLength).toBe(4000)
    const third = JSON.parse((await tool.execute({ action: 'read', callId: 'call-1', offset: 8000, limit: 4000 }, ctx)).output)
    expect(third.returnedLength).toBe(1000)
    expect(third.hasMore).toBe(false)
    expect(third.nextOffset).toBeNull()

    expect(first.content + second.content + third.content).toBe('X'.repeat(9000))
  })

  it('不存在的 callId 返回明确错误（isError，非空串成功）', async () => {
    const tool = new ReadHistoryTool([msg])
    const res = await tool.execute({ action: 'read', callId: 'missing' }, ctx)
    expect(res.isError).toBe(true)
    const body = JSON.parse(res.output)
    expect(body.error).toBe('HISTORY_CALL_NOT_FOUND')
  })

  it('缺少 callId 返回明确错误', async () => {
    const tool = new ReadHistoryTool([msg])
    const res = await tool.execute({ action: 'read' }, ctx)
    expect(res.isError).toBe(true)
    expect(JSON.parse(res.output).error).toBe('HISTORY_MISSING_CALL_ID')
  })

  it('非法 action 返回明确错误', async () => {
    const tool = new ReadHistoryTool([msg])
    const res = await tool.execute({ action: 'delete' }, ctx)
    expect(res.isError).toBe(true)
    expect(JSON.parse(res.output).error).toBe('HISTORY_INVALID_ACTION')
  })

  it('作用域隔离：只读当前会话，无法读取其它会话的 callId', async () => {
    const otherMsg = makeAssistantMessage({
      id: 'm2', conversationId: 'c2',
      providerPayloadJson: payload([
        { type: 'function_call', call_id: 'other-call', name: 'run', namespace: 'web', arguments: '{}' },
        { type: 'function_call_output', call_id: 'other-call', output: 'SECRET' },
      ]),
    })
    // 工具只注入当前会话（c1）的消息，不含 c2。
    const tool = new ReadHistoryTool([msg])
    const res = await tool.execute({ action: 'read', callId: 'other-call' }, ctx)
    expect(res.isError).toBe(true)
    expect(JSON.parse(res.output).error).toBe('HISTORY_CALL_NOT_FOUND')
    // list 也看不到 c2 的调用
    const list = JSON.parse((await tool.execute({ action: 'list' }, ctx)).output)
    expect(list.calls.map((c: { callId: string }) => c.callId)).toEqual(['call-1'])
  })

  it('hosted 搜索：如实说明上游未提供完整正文，callSources=自身来源，messageSources=消息聚合', async () => {
    const hostedMsg = makeAssistantMessage({
      providerPayloadJson: payload([
        { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] } },
      ]),
      webSearchResults: [{ title: 'A', url: 'https://a.example', snippet: 'S', sourceType: 'web' }],
    })
    const tool = new ReadHistoryTool([hostedMsg])
    const res = JSON.parse((await tool.execute({ action: 'read', callId: 'ws1' }, ctx)).output)
    expect(res.kind).toBe('hosted_search')
    expect(res.totalLength).toBe(0)
    expect(res.callSources).toHaveLength(1)
    expect(res.messageSources).toHaveLength(1)
    expect(res.note).toMatch(/never provided|not.*read in full|cannot be read/i)
  })

  it('client tool：callSources=null（归属未知），不冒充单次调用的来源', async () => {
    const tool = new ReadHistoryTool([msg])
    const res = JSON.parse((await tool.execute({ action: 'read', callId: 'call-1', limit: 100 }, ctx)).output)
    expect(res.callSources).toBeNull()
    expect(res.messageSources).toHaveLength(1)
    expect(res.note).toMatch(/UNKNOWN|unknown/)
  })
})
