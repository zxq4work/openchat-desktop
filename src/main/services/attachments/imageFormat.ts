// 图片格式与限制的纯函数工具（不依赖 electron，便于单元测试）。
// 主进程 AttachmentService 与 Adapter 共用。

export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

export const SUPPORTED_IMAGE_MIMES: SupportedImageMime[] = ['image/jpeg', 'image/png', 'image/webp']

// 单张图片大小上限：10MB（避免超大图进入内存 / Provider 请求体）
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
// 单条消息图片数量上限：与 Renderer 共用同一常量来源，避免主/渲染两侧漂移
export { MAX_IMAGES_PER_MESSAGE } from '../../../shared/constants'
// 缩略图最大边
export const THUMBNAIL_MAX_EDGE = 512
// 原图最长边上限：超过则等比缩放后再存原图，避免畸形巨图
export const MAX_ORIGINAL_EDGE = 4096

export const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

export function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    default: return 'bin'
  }
}

export function mimeFromExtension(ext: string): SupportedImageMime | null {
  const lower = ext.toLowerCase()
  if (lower === '.jpg' || lower === '.jpeg') return 'image/jpeg'
  if (lower === '.png') return 'image/png'
  if (lower === '.webp') return 'image/webp'
  return null
}

// 通过 magic bytes 判断真实图片类型。不信任扩展名 / 声明的 MIME。
// SVG 明确不支持（可携带脚本）。
export function detectImageMime(buffer: Buffer): SupportedImageMime | null {
  if (buffer.length < 12) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export function isSupportedImageMime(mime: string): mime is SupportedImageMime {
  return (SUPPORTED_IMAGE_MIMES as string[]).includes(mime)
}

// 等比缩放到最大边 maxEdge；若已小于等于 maxEdge 则原样返回。
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) return { width, height, scaled: false }
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height, scaled: false }
  const ratio = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  }
}
