// 文本复制：沿用既有 navigator.clipboard.writeText 方式，集中一处供多处复用。
// 异步版本返回是否复制成功，供需要「已复制」反馈的调用方使用。
export async function copyTextAsync(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function copyText(text: string): void {
  void copyTextAsync(text)
}
