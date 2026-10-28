// 搜索能力声明策略（纯函数，协议无关）。
//
// 背景：搜索功能关闭、本轮没有可用搜索工具时，需要向模型声明「本轮无搜索能力」，
// 以约束模型不得伪造工具调用、不得谎称已执行搜索、被要求搜索时如实说明。
//
// 关键区分（不得混淆）：
//   - 用户是否开启 OpenChat 搜索功能（searchEnabled）
//   - 本轮是否向模型声明了工具（tools）
//   - OpenChat 是否已在本轮代为执行预搜索（PreSearch）
// 「模型不能自行调用工具」不等于「用户关闭了搜索」。只要搜索功能已开启，
// 就绝不能注入「no web search tools / they can enable web search」这类关闭语义。
//
// 三协议（chat_completions / responses / anthropic_messages）共用同一规则：
// 协议只影响提示词的序列化位置，不影响是否注入该声明。

// 是否追加「无搜索能力」声明（NO_SEARCH_CAPABILITY_NOTICE）。
//
// 规则（按优先级）：
//   1. 本轮搜索功能已开启（Tools 或 PreSearch 降级）→ 绝不注入：
//      - Tools：已有 SEARCH_INSTRUCTIONS 说明能力（本函数不会被该路径调用）；
//      - PreSearch：无论成功 / 0 结果 / 失败，本轮都已实际执行搜索，
//        注入「建议开启搜索」会误导用户（搜索本就已开启）。
//   2. 已注入历史搜索 Provenance → 不注入：其能力说明已覆盖当前状态。
//   3. 其余情况（用户确实关闭了搜索、且无历史）→ 注入统一声明。
export function shouldIncludeNoSearchNotice(params: {
  searchEnabledThisTurn: boolean
  hasProvenanceContext: boolean
}): boolean {
  if (params.searchEnabledThisTurn) return false
  if (params.hasProvenanceContext) return false
  return true
}
