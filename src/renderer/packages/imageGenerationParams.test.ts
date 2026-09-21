import { describe, it, expect } from 'vitest'
import { buildParamOptions, isValueAllowed, profileSupportsImageToImage, maxInputImagesForProfile, PARAM_DEFAULT_VALUE } from './imageGenerationParams'
import type { ImageGenerationParameterConfig, ImageGenerationParameterProfile } from '../../shared/types/provider'

const sizeConfig: ImageGenerationParameterConfig = {
  enabled: true,
  options: [
    { label: '1K', value: '1K' },
    { label: '2K', value: '2K' },
  ],
  allowCustom: false,
}

describe('buildParamOptions', () => {
  it('prepends the default option and lists predefined values', () => {
    expect(buildParamOptions(sizeConfig)).toEqual([
      { value: PARAM_DEFAULT_VALUE, label: '默认' },
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K' },
    ])
  })

  it('returns nothing when the param is disabled or missing', () => {
    expect(buildParamOptions({ enabled: false })).toEqual([])
    expect(buildParamOptions(undefined)).toEqual([])
  })
})

describe('isValueAllowed', () => {
  it('treats empty / missing value as allowed (falls back to default)', () => {
    expect(isValueAllowed(sizeConfig, '')).toBe(true)
    expect(isValueAllowed(sizeConfig, null)).toBe(true)
    expect(isValueAllowed(undefined, '1K')).toBe(false)
  })

  it('allows a value present in the predefined options', () => {
    expect(isValueAllowed(sizeConfig, '1K')).toBe(true)
    expect(isValueAllowed(sizeConfig, '2K')).toBe(true)
  })

  it('rejects a value no longer in the options and not custom-allowed (stale option fix)', () => {
    // 用户删除了 3K：已保存的 3K 必须被判为非法，从而不再残留在下拉选项中
    expect(isValueAllowed(sizeConfig, '3K')).toBe(false)
  })

  it('allows a value when the config permits custom values (aligns with main-side validation)', () => {
    const custom: ImageGenerationParameterConfig = { enabled: true, options: [{ label: '1K', value: '1K' }], allowCustom: true }
    expect(isValueAllowed(custom, '1536x1024')).toBe(true)
  })

  it('rejects any value for a disabled param', () => {
    expect(isValueAllowed({ enabled: false }, '1K')).toBe(false)
  })
})

describe('profileSupportsImageToImage / maxInputImagesForProfile', () => {
  const base: ImageGenerationParameterProfile = {
    size: { enabled: false },
    quality: { enabled: false },
    background: { enabled: false },
    outputFormat: { enabled: false },
  }

  it('image-to-image disabled → no support, 0 max', () => {
    const profile: ImageGenerationParameterProfile = { ...base, operations: { textToImage: true, imageToImage: { enabled: false, multiple: false } } }
    expect(profileSupportsImageToImage(profile)).toBe(false)
    expect(maxInputImagesForProfile(profile)).toBe(0)
    expect(profileSupportsImageToImage(undefined)).toBe(false)
  })

  it('multiple=false → supported, max 1', () => {
    const profile: ImageGenerationParameterProfile = { ...base, operations: { textToImage: true, imageToImage: { enabled: true, multiple: false } } }
    expect(profileSupportsImageToImage(profile)).toBe(true)
    expect(maxInputImagesForProfile(profile)).toBe(1)
  })

  it('multiple=true → uses declared maxImages', () => {
    const profile: ImageGenerationParameterProfile = { ...base, operations: { textToImage: true, imageToImage: { enabled: true, multiple: true, maxImages: 4 } } }
    expect(maxInputImagesForProfile(profile)).toBe(4)
  })
})
