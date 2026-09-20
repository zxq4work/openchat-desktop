import { describe, it, expect } from 'vitest'
import {
  detectImageMime,
  fitWithin,
  mimeToExt,
  mimeFromExtension,
  isSupportedImageMime,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_ORIGINAL_EDGE,
  THUMBNAIL_MAX_EDGE,
} from './imageFormat'

// 构造最小合法文件头（magic bytes）用于类型探测
function pngHeader(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
}
function jpegHeader(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
}
function webpHeader(): Buffer {
  return Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
}

describe('detectImageMime', () => {
  it('detects PNG by magic bytes', () => {
    expect(detectImageMime(pngHeader())).toBe('image/png')
  })

  it('detects JPEG by magic bytes', () => {
    expect(detectImageMime(jpegHeader())).toBe('image/jpeg')
  })

  it('detects WebP by RIFF/WEBP header', () => {
    expect(detectImageMime(webpHeader())).toBe('image/webp')
  })

  it('rejects SVG (script-capable, unsupported)', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(detectImageMime(svg)).toBeNull()
  })

  it('rejects GIF', () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
    expect(detectImageMime(gif)).toBeNull()
  })

  it('does not trust extension: plain text named .png stays unsupported', () => {
    const fake = Buffer.from('this is not an image at all')
    expect(detectImageMime(fake)).toBeNull()
  })

  it('rejects buffers shorter than 12 bytes', () => {
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })

  it('does not treat truncated PNG header as valid', () => {
    // 第 4 字节应为 0x47(G)，此处写成 0x48(H)
    const bad = Buffer.from([0x89, 0x50, 0x4e, 0x48, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(detectImageMime(bad)).toBeNull()
  })
})

describe('fitWithin', () => {
  it('returns original size when within max edge', () => {
    expect(fitWithin(100, 50, 512)).toEqual({ width: 100, height: 50, scaled: false })
  })

  it('scales down longest edge while preserving aspect ratio', () => {
    const r = fitWithin(1024, 512, 512)
    expect(r.scaled).toBe(true)
    expect(r.width).toBe(512)
    expect(r.height).toBe(256)
  })

  it('handles portrait orientation', () => {
    const r = fitWithin(512, 2048, 1024)
    expect(r.scaled).toBe(true)
    expect(r.height).toBe(1024)
    expect(r.width).toBe(256)
  })

  it('never yields a dimension below 1px', () => {
    const r = fitWithin(10000, 1, 512)
    expect(r.width).toBe(512)
    expect(r.height).toBeGreaterThanOrEqual(1)
  })

  it('passes through invalid dimensions unchanged', () => {
    expect(fitWithin(0, 0, 512)).toEqual({ width: 0, height: 0, scaled: false })
  })

  it('scales exactly at boundary is a no-op', () => {
    expect(fitWithin(512, 512, 512).scaled).toBe(false)
  })

  // 缩略图"只缩小不放大"语义：小图必须原样返回，绝不 upscale 到 maxEdge
  it('never upscales small images (128x128 stays 128x128 at maxEdge 512)', () => {
    expect(fitWithin(128, 128, 512)).toEqual({ width: 128, height: 128, scaled: false })
    expect(fitWithin(64, 64, 512).scaled).toBe(false)
    expect(fitWithin(800, 600, 512)).toEqual({ width: 512, height: 384, scaled: true })
    expect(fitWithin(1920, 1080, 512)).toEqual({ width: 512, height: 288, scaled: true })
    expect(fitWithin(1080, 1920, 512)).toEqual({ width: 288, height: 512, scaled: true })
  })
})

describe('mime helpers', () => {
  it('maps supported mimes to extensions', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg')
    expect(mimeToExt('image/png')).toBe('png')
    expect(mimeToExt('image/webp')).toBe('webp')
    expect(mimeToExt('image/svg+xml')).toBe('bin')
  })

  it('maps extensions back to mime types', () => {
    expect(mimeFromExtension('.jpg')).toBe('image/jpeg')
    expect(mimeFromExtension('.jpeg')).toBe('image/jpeg')
    expect(mimeFromExtension('.PNG')).toBe('image/png')
    expect(mimeFromExtension('.webp')).toBe('image/webp')
    expect(mimeFromExtension('.gif')).toBeNull()
  })

  it('recognises only supported mimes', () => {
    expect(isSupportedImageMime('image/png')).toBe(true)
    expect(isSupportedImageMime('image/gif')).toBe(false)
  })
})

describe('limits', () => {
  it('keeps documented caps stable', () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_IMAGES_PER_MESSAGE).toBe(6)
    expect(THUMBNAIL_MAX_EDGE).toBe(512)
    expect(MAX_ORIGINAL_EDGE).toBe(4096)
  })
})
