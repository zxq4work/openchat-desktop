import { describe, it, expect } from 'vitest'
import { supportsImageFromModalities } from './imageCapability'

// input_modalities 三态语义（Main 与 Renderer 共用同一实现，行为必然一致）。
describe('supportsImageFromModalities (tri-state input_modalities)', () => {
  it('A. ["text","image"] → image allowed', () => {
    expect(supportsImageFromModalities(['text', 'image'])).toBe(true)
  })

  it('B. ["text"] → image blocked (server explicitly text-only)', () => {
    expect(supportsImageFromModalities(['text'])).toBe(false)
  })

  it('C. undefined / null / 未返回 → 能力未知，保持 legacy/default 行为（不阻止图片）', () => {
    expect(supportsImageFromModalities(undefined)).toBe(true)
    expect(supportsImageFromModalities(null)).toBe(true)
  })

  it('D. [] → 明确返回的空数组 → image blocked', () => {
    expect(supportsImageFromModalities([])).toBe(false)
  })
})
