import { describe, it, expect } from 'vitest'
import {
  providerPayloadHasHostedWebSearchCall,
  segmentNeedsNonLiteForHostedHistory,
} from './searchHistoryCompatibility'
import type { Message } from '../../../../shared/types/conversation'

// 构造最小 Message；只填充判定用到的字段，其余以 as unknown 断言，避免噪音。
const msg = (partial: Partial<Message>): Message =>
  ({ role: 'assistant', status: 'completed', providerPayloadJson: null, ...partial } as unknown as Message)

const v2 = (items: Array<{ type: string }>): string => JSON.stringify({ provider: 'chatgpt_codex', protocol: 'chatgpt_codex', items })

describe('providerPayloadHasHostedWebSearchCall', () => {
  it('V2 schema 含 web_search_call → true', () => {
    expect(providerPayloadHasHostedWebSearchCall(v2([{ type: 'web_search_call' }]))).toBe(true)
  })

  it('V2 schema 仅 function_call/function_call_output → false', () => {
    expect(providerPayloadHasHostedWebSearchCall(v2([{ type: 'function_call' }, { type: 'function_call_output' }]))).toBe(false)
  })

  it('legacy hostedSearchCalls（非空）→ true', () => {
    expect(providerPayloadHasHostedWebSearchCall(JSON.stringify({ hostedSearchCalls: [{ url: 'https://a' }] }))).toBe(true)
  })

  it('legacy hostedSearchCalls（空）→ false', () => {
    expect(providerPayloadHasHostedWebSearchCall(JSON.stringify({ hostedSearchCalls: [] }))).toBe(false)
  })

  it('无法解析的 JSON → false（不抛错）', () => {
    expect(providerPayloadHasHostedWebSearchCall('{not json')).toBe(false)
  })
})

describe('segmentNeedsNonLiteForHostedHistory — 检测范围与 buildCanonicalRequest 一致', () => {
  it('completed assistant + hosted payload → true', () => {
    expect(segmentNeedsNonLiteForHostedHistory([msg({ providerPayloadJson: v2([{ type: 'web_search_call' }]) })])).toBe(true)
  })

  it('非 completed（streaming）assistant + hosted payload → false（与序列化范围一致）', () => {
    expect(segmentNeedsNonLiteForHostedHistory([msg({ status: 'streaming', providerPayloadJson: v2([{ type: 'web_search_call' }]) })])).toBe(false)
  })

  it('user 消息即使带 hosted payload → false（只统计 assistant）', () => {
    expect(segmentNeedsNonLiteForHostedHistory([msg({ role: 'user', providerPayloadJson: v2([{ type: 'web_search_call' }]) })])).toBe(false)
  })

  it('无 provider payload → false', () => {
    expect(segmentNeedsNonLiteForHostedHistory([msg({ providerPayloadJson: null }), msg({ role: 'user' })])).toBe(false)
  })

  // ---- 场景 A：Standalone Lite → Hosted → Standalone 混合历史 ----
  it('场景 A: 混合历史（standalone function_call + hosted web_search_call）→ true（必须 Non-Lite）', () => {
    const history: Message[] = [
      msg({ role: 'user' }),
      msg({ providerPayloadJson: v2([{ type: 'function_call' }, { type: 'function_call_output' }]) }),
      msg({ role: 'user' }),
      msg({ providerPayloadJson: v2([{ type: 'web_search_call' }]) }),
    ]
    expect(segmentNeedsNonLiteForHostedHistory(history)).toBe(true)
  })

  // ---- 场景 B：多轮 standalone，只要历史仍含 hosted → 持续 Non-Lite ----
  it('场景 B: hosted 历史仍在 → true（多轮持续 Non-Lite）', () => {
    const history: Message[] = [
      msg({ providerPayloadJson: v2([{ type: 'web_search_call' }]) }),
      msg({ providerPayloadJson: v2([{ type: 'function_call' }, { type: 'function_call_output' }]) }),
    ]
    expect(segmentNeedsNonLiteForHostedHistory(history)).toBe(true)
  })

  it('场景 B: 全新会话（无 hosted 历史）→ false（保持 Lite）', () => {
    const history: Message[] = [
      msg({ role: 'user' }),
      msg({ role: 'assistant', providerPayloadJson: null }),
    ]
    expect(segmentNeedsNonLiteForHostedHistory(history)).toBe(false)
  })

  // ---- 场景 C：standalone function_call 历史，无 hosted → 可保持 Lite（Hosted 方向由 adapter 序列化保证） ----
  it('场景 C: 仅 standalone function_call 历史 → false', () => {
    const history: Message[] = [
      msg({ providerPayloadJson: v2([{ type: 'function_call' }, { type: 'function_call_output' }]) }),
    ]
    expect(segmentNeedsNonLiteForHostedHistory(history)).toBe(false)
  })
})
