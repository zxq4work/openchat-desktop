// 文本复制：沿用既有 navigator.clipboard.writeText 方式，集中一处供多处复用。
export function copyText(text: string): void {
  if (!text) return
  navigator.clipboard.writeText(text)
}
