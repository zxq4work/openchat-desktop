import { describe, it, expect } from 'vitest'
import {
  readJpegExifOrientation,
  orientationNeedsTransform,
  normalizeBitmapOrientation,
} from './imageOrientation'

// 构造一个含 APP1/Exif 的最小 JPEG，仅用于验证方向解析。
function buildJpegWithOrientation(orientation: number): Buffer {
  // TIFF 头（小端 II）
  const tiff = Buffer.alloc(2 + 2 + 4 + 2 + 12 + 4)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(0x002a, 2)
  tiff.writeUInt32LE(8, 4) // IFD0 偏移
  tiff.writeUInt16LE(1, 8) // entry count
  const entry = 10
  tiff.writeUInt16LE(0x0112, entry) // Orientation tag
  tiff.writeUInt16LE(3, entry + 2)  // SHORT
  tiff.writeUInt32LE(1, entry + 4)  // count
  tiff.writeUInt16LE(orientation, entry + 8)
  tiff.writeUInt32LE(0, entry + 10) // next IFD

  const exifHeader = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) // "Exif\0\0"
  const payload = Buffer.concat([exifHeader, tiff])
  const segLen = payload.length + 2

  const app1 = Buffer.alloc(4 + payload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(segLen, 2)
  payload.copy(app1, 4)

  // SOI + APP1 + SOS（简单结束）
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x02])])
}

describe('readJpegExifOrientation', () => {
  it('reads orientation=6 from EXIF APP1', () => {
    expect(readJpegExifOrientation(buildJpegWithOrientation(6))).toBe(6)
  })

  it('reads orientation=8', () => {
    expect(readJpegExifOrientation(buildJpegWithOrientation(8))).toBe(8)
  })

  it('reads orientation=1 (no transform)', () => {
    expect(readJpegExifOrientation(buildJpegWithOrientation(1))).toBe(1)
  })

  it('returns 1 for non-JPEG input', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(readJpegExifOrientation(png)).toBe(1)
  })

  it('returns 1 for a JPEG without EXIF', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])
    expect(readJpegExifOrientation(jpeg)).toBe(1)
  })

  it('returns 1 for truncated EXIF without crashing', () => {
    const full = buildJpegWithOrientation(6)
    expect(readJpegExifOrientation(full.subarray(0, 10))).toBe(1)
  })
})

describe('orientationNeedsTransform', () => {
  it('only 2..8 need transform', () => {
    expect(orientationNeedsTransform(1)).toBe(false)
    expect(orientationNeedsTransform(2)).toBe(true)
    expect(orientationNeedsTransform(8)).toBe(true)
    expect(orientationNeedsTransform(0)).toBe(false)
    expect(orientationNeedsTransform(9)).toBe(false)
  })
})

// 构造 2x1 像素的 BGRA：像素 A=(1,2,3,255)，像素 B=(4,5,6,255)
function sampleBitmap(): { data: Buffer; width: number; height: number } {
  const data = Buffer.from([
    1, 2, 3, 255, 4, 5, 6, 255,
  ])
  return { data, width: 2, height: 1 }
}

describe('normalizeBitmapOrientation', () => {
  it('orientation=1 is a no-op', () => {
    const { data, width, height } = sampleBitmap()
    const out = normalizeBitmapOrientation(data, width, height, 1)
    expect(out.width).toBe(2)
    expect(out.height).toBe(1)
    expect(out.data.equals(data)).toBe(true)
  })

  it('orientation=6 rotates 90° CW and swaps dimensions', () => {
    const { data, width, height } = sampleBitmap()
    const out = normalizeBitmapOrientation(data, width, height, 6)
    expect(out.width).toBe(1)
    expect(out.height).toBe(2)
    // 2x1 [A B] 顺时针 90° → 1x2 [A; B]
    expect(out.data[0]).toBe(1)
    expect(out.data[4]).toBe(4)
  })

  it('orientation=3 rotates 180° keeping dimensions', () => {
    const { data, width, height } = sampleBitmap()
    const out = normalizeBitmapOrientation(data, width, height, 3)
    expect(out.width).toBe(2)
    expect(out.height).toBe(1)
    // [A B] → [B A]
    expect(out.data[0]).toBe(4)
    expect(out.data[4]).toBe(1)
  })

  it('orientation=2 mirrors horizontally', () => {
    const { data, width, height } = sampleBitmap()
    const out = normalizeBitmapOrientation(data, width, height, 2)
    expect(out.data[0]).toBe(4)
    expect(out.data[4]).toBe(1)
  })

  it('returns input unchanged when buffer length mismatches', () => {
    const bad = Buffer.from([1, 2, 3])
    const out = normalizeBitmapOrientation(bad, 2, 1, 6)
    expect(out.data.equals(bad)).toBe(true)
    expect(out.width).toBe(2)
  })
})
