// Adapter 层的 defensive error：Canonical Request 已包含 image part，
// 但当前 Adapter/模型无法把图片交给 Provider 时，必须显式失败。
//
// 绝不允许"静默降级为纯文本"：那会导致用户以为模型看到了图片，
// 实际 Provider 只收到了文字。
export class UnsupportedImageInputError extends Error {
  code = 'UNSUPPORTED_IMAGE_INPUT'
  constructor(reason = '当前模型不支持图片输入') {
    super(reason)
    this.name = 'UnsupportedImageInputError'
  }
}

// Standalone 搜索路径的协议隔离异常：本轮不应产生 hosted web_search_call，
// 但上游仍发起了新的 Hosted 搜索。说明工具隔离未能（完全）约束 Hosted 搜索。
//
// 处理原则（绝不静默）：
//   - 不得把该轮当作正常完成（否则用户会看到"成功"却含未处理的 hosted 结果）；
//   - 通过统一错误机制结束本次生成，向用户显式展示异常；
//   - 不修改/删除任何已有历史。
//
// 注意：这不是"已完全禁止 Hosted 搜索"的证明，而是兜底检测——隔离为 best-effort。
export class CodexProtocolIsolationError extends Error {
  code = 'CODEX_HOSTED_SEARCH_LEAKED'
  constructor(reason = 'Standalone 搜索期间检测到未预期的 Hosted 搜索事件，已中止本轮生成') {
    super(reason)
    this.name = 'CodexProtocolIsolationError'
  }
}
