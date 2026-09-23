// 图片输入能力判定（Main 与 Renderer 共用，保证两侧行为一致）。
//
// input_modalities 是服务端 optional metadata，采用三态语义：
//   1. 明确存在且包含 'image'           → 支持图片（true）
//   2. 明确存在但不包含 'image'（含 []） → 不支持图片（false）
//   3. undefined / null / 未返回          → 能力未知，保持重构前原有图片发送行为（允许，true）
//
// 关键：字段缺失绝不解释为「明确只支持 text」。
// 只有服务端明确返回不含 'image' 的数组才阻止图片发送。
export function supportsImageFromModalities(inputModalities: string[] | null | undefined): boolean {
  if (inputModalities == null) return true
  return inputModalities.includes('image')
}
