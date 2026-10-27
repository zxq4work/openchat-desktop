// 搜索声明策略（纯函数，便于单测）。
//
// 背景：runGenerationDirect 在无搜索时追加 NO_SEARCH_CAPABILITY_NOTICE：
//   "You do not have web search tools available" / "Answer directly based on your training knowledge"
// 而 search provenance 说明：「这些搜索在更早的轮次确实执行过，结果如下」。
// 二者同时注入时语义冲突，模型倾向于否认已发生的历史搜索（chat_completions 实测故障）。

// 是否追加「无搜索能力」声明（NO_SEARCH_CAPABILITY_NOTICE）。
//
// 核心规则：只要本轮已经注入了历史搜索事实（provenance），就绝不再追加 NOTICE，
// 否则二者互相否定。其余情况保持各自既有行为，避免影响 PreSearch / 其它协议。
export function shouldIncludeNoSearchNotice(params: {
  protocol: string
  searchEnabledThisTurn: boolean
  hasSearchHistory: boolean
  hasProvenanceContext: boolean
}): boolean {
  // 本轮搜索已启用（PreSearch 回退路径）：保持既有行为
  if (params.searchEnabledThisTurn) return true
  // 已注入 provenance → 不再追加冲突模板（本轮修复的核心）
  if (params.hasProvenanceContext) return false
  // Anthropic：无历史即纯净对话（无声明）；有历史但无 provenance 时兜底说明
  if (params.protocol === 'anthropic_messages') return params.hasSearchHistory
  // 其它协议无历史：保持原行为
  return true
}
