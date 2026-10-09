// Hosted 历史与 Responses Lite 的传输兼容性判定（纯函数，无副作用）。
//
// 背景：Hosted 搜索产生 provider-native 的 web_search_call item，只能由普通 Responses
// （Non-Lite）传输重放。Lite transport 只接受 function / custom / client-executed tool
// search；把 hosted web_search_call 作为 input item 发进 Lite 会话，会被上游以
// "response protection is unavailable" 拒绝。
//
// 因此，只要「本次请求实际需要重放的历史」中含 hosted web_search_call，
// 请求就必须整体走 Non-Lite。检测范围必须与 buildCanonicalRequest 序列化历史的范围一致，
// 否则会出现「检测说有 → 实际没发」或「实际发了 → 检测说没有」的不一致。

import type { Message } from '../../../../shared/types/conversation'

// 判断单个 provider payload 是否含 hosted web_search_call。
// 兼容 V2 schema（{ items:[{type:'web_search_call'}]}）与 legacy hostedSearchCalls。
export function providerPayloadHasHostedWebSearchCall(providerPayloadJson: string): boolean {
  try {
    const payload = JSON.parse(providerPayloadJson) as Record<string, unknown>
    if (Array.isArray(payload.items)) {
      return (payload.items as Array<{ type?: string }>).some((it) => it?.type === 'web_search_call')
    }
    if (Array.isArray(payload.hostedSearchCalls)) {
      return (payload.hostedSearchCalls as unknown[]).length > 0
    }
  } catch {
    // 无法解析的 payload 不参与判断
  }
  return false
}

// 判断给定消息集合是否需要以 Non-Lite 重放 hosted web_search_call 历史。
// 仅统计 status==='completed' 的 assistant 消息 —— 与 buildCanonicalRequest 的
// 历史序列化范围完全一致（skip 非 completed 消息、只看 assistant 的 provider payload）。
export function segmentNeedsNonLiteForHostedHistory(segmentMessages: Message[]): boolean {
  return segmentMessages.some(
    (m) =>
      m.role === 'assistant' &&
      m.status === 'completed' &&
      !!m.providerPayloadJson &&
      providerPayloadHasHostedWebSearchCall(m.providerPayloadJson)
  )
}
