// 图片槽位尺寸计算：占位骨架与最终生成图共用同一套「贴入 max 方框且不放大」逻辑。
// 目标：槽位高度与最终图片渲染尺寸一致，占位 → 结果 阶段 scrollHeight 稳定。

// 生成图 / 参考图的单图显示上限（与 .message-image-grid--single 的 max-width/height 一致）。
export const IMAGE_SLOT_MAX = 320

// 从请求尺寸字符串（如 "1024x1536"）解析像素宽高。
// 形如 "WIDTHxHEIGHT"（x / X / ×）才解析；其它（"auto" / "2K" / 非法值）返回 null，
// 由调用方回退到默认正方形占位，绝不猜测 Provider 的真实输出比例。
export function parseRequestedDims(size: string | null | undefined): { width: number; height: number } | null {
  if (!size) return null
  const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(size)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

// 贴入 max×max 方框且【不放大】，与 CSS 的 width/height:auto + max-width/height 收缩语义一致。
// 小图保持原尺寸（避免槽位被撑大后图片周围留白），大图按比例缩到上限内。
export function fitSlot(
  width: number,
  height: number,
  max = IMAGE_SLOT_MAX
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: max, height: max }
  }
  const scale = Math.min(1, max / width, max / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
