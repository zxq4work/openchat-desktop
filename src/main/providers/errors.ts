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
