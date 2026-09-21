import { describe, it, expect } from 'vitest'
import {
  openAIImageProfile,
  customMinimalProfile,
  customImageToImageProfile,
  normalizeImageGenerationProfile,
  validateParameterValue,
  validateRequestedParams,
  reconcileImageDefaults,
  normalizeOperations,
  validateInputImageCount,
  resolveMaxInputImages,
  clampMaxImages,
  validateImageGenerationPayloadPath,
  normalizeRequestMapping,
  migrateLegacyRequestMapping,
  MAX_GENERATION_INPUT_IMAGES,
  IMAGE_GENERATION_PROFILE_VERSION,
} from './parameterProfile'

describe('presets', () => {
  it('OpenAI preset enables all four params with options', () => {
    const p = openAIImageProfile()
    expect(p.size.enabled).toBe(true)
    expect(p.size.options?.map((o) => o.value)).toEqual(['1024x1024', '1536x1024', '1024x1536'])
    expect(p.quality.options?.map((o) => o.value)).toEqual(['low', 'medium', 'high'])
    expect(p.background.options?.map((o) => o.value)).toEqual(['opaque', 'transparent'])
    expect(p.outputFormat.options?.map((o) => o.value)).toEqual(['png', 'jpeg', 'webp'])
  })

  it('custom minimal preset disables everything', () => {
    const p = customMinimalProfile()
    expect(p.size.enabled).toBe(false)
    expect(p.quality.enabled).toBe(false)
    expect(p.background.enabled).toBe(false)
    expect(p.outputFormat.enabled).toBe(false)
  })
})

describe('normalizeImageGenerationProfile', () => {
  it('round-trips a serialized profile', () => {
    const p = openAIImageProfile()
    const restored = normalizeImageGenerationProfile(JSON.parse(JSON.stringify(p)))
    expect(restored).toEqual(p)
  })

  it('falls back to minimal for null/garbage', () => {
    expect(normalizeImageGenerationProfile(null)).toEqual(customMinimalProfile())
    expect(normalizeImageGenerationProfile('nope')).toEqual(customMinimalProfile())
  })

  it('keeps options / allowCustom / enabled through serialization', () => {
    const custom = customMinimalProfile()
    custom.size = {
      enabled: true,
      options: [
        { label: '1K', value: '1K' },
        { label: '2K', value: '2K' },
      ],
      allowCustom: true,
    }
    const restored = normalizeImageGenerationProfile(JSON.parse(JSON.stringify(custom)))
    expect(restored.size.enabled).toBe(true)
    expect(restored.size.allowCustom).toBe(true)
    expect(restored.size.options?.map((o) => o.value)).toEqual(['1K', '2K'])
  })
})

describe('validateParameterValue', () => {
  it('rejects any value when the param is disabled', () => {
    expect(validateParameterValue('size', { enabled: false }, '1K')).toContain('不支持')
  })

  it('accepts only enumerated values', () => {
    const config = { enabled: true, options: [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }] }
    expect(validateParameterValue('size', config, '1K')).toBeNull()
    expect(validateParameterValue('size', config, 'auto')).not.toBeNull()
  })

  it('allows WIDTHxHEIGHT when allowCustom', () => {
    const config = { enabled: true, options: [{ label: '1K', value: '1K' }], allowCustom: true }
    expect(validateParameterValue('size', config, '1536x1024')).toBeNull()
    expect(validateParameterValue('size', config, '1536x1024X')) .not.toBeNull()
    expect(validateParameterValue('size', config, 'big')).not.toBeNull()
  })
})

describe('validateRequestedParams (Service authoritative layer)', () => {
  it('custom profile: default (undefined) sends nothing beyond model/prompt/n', () => {
    const profile = { ...customMinimalProfile(), size: { enabled: true, options: [{ label: '1K', value: '1K' }], allowCustom: true } }
    const { cleaned, error } = validateRequestedParams(profile, {})
    expect(error).toBeNull()
    expect(cleaned).toEqual({})
  })

  it('rejects a value for a disabled param (no bypassing UI)', () => {
    const profile = customMinimalProfile()
    const { error } = validateRequestedParams(profile, { outputFormat: 'png' })
    expect(error).toContain('不支持')
    // 面向用户，使用中文参数名（不暴露 outputFormat 内部字段名）
    expect(error).toContain('输出格式')
    expect(error).not.toContain('outputFormat')
  })

  it("accepts an explicitly-chosen 'auto' only when it is a declared option", () => {
    const profile = { ...customMinimalProfile(), size: { enabled: true, options: [{ label: 'API Auto', value: 'auto' }] } }
    expect(validateRequestedParams(profile, { size: 'auto' }).error).toBeNull()
    const profileNoAuto = { ...customMinimalProfile(), size: { enabled: true, options: [{ label: '1K', value: '1K' }] } }
    expect(validateRequestedParams(profileNoAuto, { size: 'auto' }).error).not.toBeNull()
  })

  it('OpenAI profile passes outputFormat=webp', () => {
    const { cleaned, error } = validateRequestedParams(openAIImageProfile(), { outputFormat: 'webp' })
    expect(error).toBeNull()
    expect(cleaned.outputFormat).toBe('webp')
  })

  it('OpenAI profile with default size sends no size', () => {
    const { cleaned } = validateRequestedParams(openAIImageProfile(), { quality: 'high' })
    expect(cleaned.size).toBeUndefined()
    expect(cleaned.quality).toBe('high')
  })
})

describe('operations profile (text-to-image / image-to-image)', () => {
  it('OpenAI preset: text-to-image only, no reference images', () => {
    const p = openAIImageProfile()
    expect(p.operations?.textToImage).toBe(true)
    expect(p.operations?.imageToImage.enabled).toBe(false)
  })

  it('custom minimal preset: text-to-image only (never guess image-to-image)', () => {
    const p = customMinimalProfile()
    expect(p.operations?.textToImage).toBe(true)
    expect(p.operations?.imageToImage.enabled).toBe(false)
  })

  it('custom image-to-image profile: capability template only — no wire mapping', () => {
    const p = customImageToImageProfile()
    expect(p.version).toBe(IMAGE_GENERATION_PROFILE_VERSION)
    expect(p.operations?.textToImage).toBe(true)
    expect(p.operations?.imageToImage.enabled).toBe(true)
    expect(p.operations?.imageToImage.multiple).toBe(true)
    // Custom preset 只表达能力，绝不携带任何供应商特有 wire mapping
    expect(p.requestMapping).toBeUndefined()
  })

  it('normalizeOperations: missing/invalid → text-to-image only', () => {
    expect(normalizeOperations(undefined)).toEqual({ textToImage: true, imageToImage: { enabled: false, multiple: false } })
    expect(normalizeOperations('nope').imageToImage.enabled).toBe(false)
  })

  it('normalizeOperations: only explicit enabled=true turns on image-to-image', () => {
    expect(normalizeOperations({ imageToImage: { enabled: 'yes' } }).imageToImage.enabled).toBe(false)
    expect(normalizeOperations({ imageToImage: { enabled: true, multiple: true, maxImages: 3 } }).imageToImage).toEqual({ enabled: true, multiple: true, maxImages: 3 })
  })

  it('round-trips an explicitly-configured requestMapping through serialization', () => {
    const profile = {
      ...customImageToImageProfile(),
      requestMapping: {
        inputImages: { path: 'extra_body.image', cardinality: 'array' as const, encoding: 'data_url' as const },
        responseFormatParameter: { enabled: true, path: 'extra_body.response_format', valueType: 'string' as const, value: 'b64_json' },
      },
    }
    const restored = normalizeImageGenerationProfile(JSON.parse(JSON.stringify(profile)))
    expect(restored.operations?.imageToImage.enabled).toBe(true)
    expect(restored.requestMapping?.inputImages?.path).toBe('extra_body.image')
    expect(restored.requestMapping?.responseFormatParameter?.value).toBe('b64_json')
  })

  it('custom preset alone (no mapping) normalizes without inventing any reference-image field', () => {
    const restored = normalizeImageGenerationProfile(JSON.parse(JSON.stringify(customImageToImageProfile())))
    expect(restored.operations?.imageToImage.enabled).toBe(true)
    // 绝不自动补 extra_body.image
    expect(restored.requestMapping?.inputImages).toBeUndefined()
  })
})

describe('validateImageGenerationPayloadPath (protocol field safety)', () => {
  it('accepts a top-level field and extra_body.<field>', () => {
    expect(validateImageGenerationPayloadPath('image')).toBeNull()
    expect(validateImageGenerationPayloadPath('response_format')).toBeNull()
    expect(validateImageGenerationPayloadPath('extra_body.image')).toBeNull()
    expect(validateImageGenerationPayloadPath('extra_body.response_format')).toBeNull()
  })

  it('rejects nested paths beyond two segments', () => {
    expect(validateImageGenerationPayloadPath('a.b.c')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('extra_body.a.b')).not.toBeNull()
  })

  it('rejects a non-extra_body two-segment path', () => {
    expect(validateImageGenerationPayloadPath('foo.bar')).not.toBeNull()
  })

  it('rejects prototype-pollution field names', () => {
    expect(validateImageGenerationPayloadPath('__proto__')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('extra_body.__proto__')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('constructor')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('prototype')).not.toBeNull()
  })

  it('rejects empty and malformed paths', () => {
    expect(validateImageGenerationPayloadPath('')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('  ')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('1bad')).not.toBeNull()
    expect(validateImageGenerationPayloadPath('has space')).not.toBeNull()
  })
})

describe('normalizeRequestMapping (v2)', () => {
  it('keeps a valid mapping', () => {
    const rm = normalizeRequestMapping({
      inputImages: { path: 'extra_body.image', cardinality: 'single', encoding: 'data_url' },
      responseFormatParameter: { enabled: true, path: 'response_format', valueType: 'boolean', value: true },
    })
    expect(rm?.inputImages).toEqual({ path: 'extra_body.image', cardinality: 'single', encoding: 'data_url' })
    expect(rm?.responseFormatParameter).toEqual({ enabled: true, path: 'response_format', valueType: 'boolean', value: true })
  })

  it('drops an invalid input path but keeps a valid response mapping', () => {
    const rm = normalizeRequestMapping({
      inputImages: { path: '__proto__.x', cardinality: 'array' },
      responseFormatParameter: { enabled: true, path: 'extra_body.response_format', valueType: 'string', value: 'b64_json' },
    })
    expect(rm?.inputImages).toBeUndefined()
    expect(rm?.responseFormatParameter?.value).toBe('b64_json')
  })

  it('drops a response mapping that is enabled but has no path', () => {
    const rm = normalizeRequestMapping({ responseFormatParameter: { enabled: true, path: '', valueType: 'string', value: 'b64_json' } })
    expect(rm).toBeUndefined()
  })

  it('returns undefined for empty/garbage input', () => {
    expect(normalizeRequestMapping(undefined)).toBeUndefined()
    expect(normalizeRequestMapping({})).toBeUndefined()
  })
})

describe('migrateLegacyRequestMapping (v1 → v2)', () => {
  it('migrates extra_body_image → extra_body.image array', () => {
    const rm = migrateLegacyRequestMapping(
      { enabled: true, transport: 'extra_body_image', encoding: 'data_url', multiple: true, maxImages: 4 },
      { transport: 'extra_body', format: 'b64_json' }
    )
    expect(rm?.inputImages).toEqual({ path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' })
    expect(rm?.responseFormatParameter).toEqual({ enabled: true, path: 'extra_body.response_format', valueType: 'string', value: 'b64_json' })
  })

  it('migrates top_level_image → top-level image field', () => {
    const rm = migrateLegacyRequestMapping({ enabled: true, transport: 'top_level_image', encoding: 'data_url', multiple: false }, undefined)
    expect(rm?.inputImages).toEqual({ path: 'image', cardinality: 'single', encoding: 'data_url' })
  })

  it('migrates custom transport via payloadPath', () => {
    const rm = migrateLegacyRequestMapping({ enabled: true, transport: 'custom', payloadPath: 'extra_body.refs', multiple: true }, undefined)
    expect(rm?.inputImages).toEqual({ path: 'extra_body.refs', cardinality: 'array', encoding: 'data_url' })
  })

  it('maps a v1 response with no fixed format → enabled:false (send nothing)', () => {
    const rm = migrateLegacyRequestMapping(undefined, { transport: 'extra_body' })
    expect(rm?.responseFormatParameter).toEqual({ enabled: false, path: '', valueType: 'string', value: '' })
  })

  it('migrates top_level response transport', () => {
    const rm = migrateLegacyRequestMapping(undefined, { transport: 'top_level', format: 'url' })
    expect(rm?.responseFormatParameter?.path).toBe('response_format')
  })

  it('returns undefined when there is nothing to migrate', () => {
    expect(migrateLegacyRequestMapping(undefined, undefined)).toBeUndefined()
    expect(migrateLegacyRequestMapping({ enabled: false }, undefined)).toBeUndefined()
  })
})

describe('normalizeImageGenerationProfile — v1 migration end-to-end', () => {
  it('migrates a stored v1 image-to-image profile into requestMapping', () => {
    const v1 = {
      size: { enabled: true, options: [{ label: '1K', value: '1K' }] },
      quality: { enabled: false },
      background: { enabled: false },
      outputFormat: { enabled: false },
      operations: { textToImage: true, imageToImage: { enabled: true, multiple: true, maxImages: 4 } },
      inputImages: { enabled: true, transport: 'extra_body_image', encoding: 'data_url', multiple: true, maxImages: 4 },
      response: { transport: 'extra_body', format: 'b64_json' },
    }
    const migrated = normalizeImageGenerationProfile(v1)
    expect(migrated.version).toBe(IMAGE_GENERATION_PROFILE_VERSION)
    expect(migrated.requestMapping?.inputImages?.path).toBe('extra_body.image')
    expect(migrated.requestMapping?.responseFormatParameter?.value).toBe('b64_json')
  })

  it('image-to-image enabled but no mapping → never invents a reference-image field', () => {
    const profile = normalizeImageGenerationProfile({
      operations: { textToImage: true, imageToImage: { enabled: true, multiple: true, maxImages: 3 } },
    })
    expect(profile.operations?.imageToImage.enabled).toBe(true)
    expect(profile.requestMapping?.inputImages).toBeUndefined()
  })
})

describe('validateInputImageCount / resolveMaxInputImages (Service authoritative layer)', () => {
  it('image-to-image disabled: any reference image is rejected', () => {
    expect(validateInputImageCount(openAIImageProfile(), 1)).toContain('参考图')
    expect(resolveMaxInputImages(openAIImageProfile())).toBe(0)
  })

  it('multiple=false rejects the 2nd image', () => {
    const profile = { ...customMinimalProfile(), operations: { textToImage: true, imageToImage: { enabled: true, multiple: false } } }
    expect(validateInputImageCount(profile, 1)).toBeNull()
    expect(validateInputImageCount(profile, 2)).toContain('多张')
    expect(resolveMaxInputImages(profile)).toBe(1)
  })

  it('maxImages=N rejects beyond N', () => {
    const profile = { ...customMinimalProfile(), operations: { textToImage: true, imageToImage: { enabled: true, multiple: true, maxImages: 3 } } }
    expect(validateInputImageCount(profile, 3)).toBeNull()
    expect(validateInputImageCount(profile, 4)).toContain('上限')
    expect(resolveMaxInputImages(profile)).toBe(3)
  })

  it('clamps maxImages to [1, hard cap]', () => {
    expect(clampMaxImages(0)).toBe(1)
    expect(clampMaxImages(999)).toBe(MAX_GENERATION_INPUT_IMAGES)
  })
})

describe('stale param clearing (Custom outputFormat disabled)', () => {
  it("a stale outputFormat='png' for a disabled param is rejected by the authoritative layer", () => {
    // Service 对"显式请求了未启用参数"必须拒绝，不能静默通过
    const { error } = validateRequestedParams(customMinimalProfile(), { outputFormat: 'png', size: '2K' })
    expect(error).not.toBeNull()
  })

  it('reconciliation clears stale outputFormat via disabled profile', () => {
    const next = reconcileImageDefaults(customMinimalProfile(), { size: '2K', quality: null, background: null })
    // outputFormat 不在 reconcile 范围内（会话无该默认字段），此处确认 size 也被清空
    expect(next.size).toBeNull()
  })
})

describe('reconcileImageDefaults (provider switch)', () => {
  it('keeps values still valid in the new profile', () => {
    const profile = { ...customMinimalProfile(), size: { enabled: true, options: [{ label: '2K', value: '2K' }] } }
    const next = reconcileImageDefaults(profile, { size: '2K', quality: 'high', background: 'transparent' })
    expect(next.size).toBe('2K')
    // quality / background 未启用 → 清空
    expect(next.quality).toBeNull()
    expect(next.background).toBeNull()
  })

  it('clears a value not present in the new profile (no forced replacement)', () => {
    // 图生图预设 2K → OpenAI（不含 2K）
    const next = reconcileImageDefaults(openAIImageProfile(), { size: '2K', quality: null, background: null })
    expect(next.size).toBeNull()
  })
})
