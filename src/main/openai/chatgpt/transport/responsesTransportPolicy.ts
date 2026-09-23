// 正式的 Responses Transport Policy（纯函数，无副作用、无 env、无网络）。
//
// 语义：
//   ModelInfo.useResponsesLite = 该模型「默认」使用 Responses Lite，
//   而不是「该模型永远只能使用 Responses Lite」。
//
// 是否必须覆盖为 Non-Lite，由「本次请求真正需要的功能」决定：
//   effectiveResponsesLite = modelWantsResponsesLite && !requiresNonLiteTransport
//
// 已真实网络验证的唯一 Non-Lite 需求：codex-hosted（顶层 hosted web_search）。
// 其余搜索策略（none / codex-standalone）保持模型 metadata 的 Lite 倾向。
// 绝不按模型 slug 特判：未来新模型只要 metadata 一致，自然进入相同逻辑。

export interface ResponsesTransportPolicyInput {
  modelWantsResponsesLite: boolean
  searchStrategy: string
}

// 当前唯一「真实确认」需要 Non-Lite transport 的功能组合：codex-hosted。
// 不要为尚未完成同等真实网络验证的能力（image input / image generation /
// file_search / computer_use / code_interpreter / custom tool / Code Mode 等）
// 扩展此函数——那会引入未被验证的假设。
export function requiresNonLiteTransport(input: { searchStrategy: string }): boolean {
  return input.searchStrategy === 'codex-hosted'
}

// 计算真正驱动 wire protocol（header / reasoning.context / parallel_tool_calls /
// tool serializer / include / tool_choice）的 effectiveResponsesLite。
export function resolveEffectiveResponsesLite(input: ResponsesTransportPolicyInput): boolean {
  if (input.modelWantsResponsesLite !== true) {
    // 非 Lite 模型：任何搜索策略都保持 Non-Lite。
    return false
  }
  // Lite 模型：仅当本次请求不需要 Non-Lite transport 时才使用 Lite。
  return !requiresNonLiteTransport({ searchStrategy: input.searchStrategy })
}
