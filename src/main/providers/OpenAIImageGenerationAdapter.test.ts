import { describe, it, expect } from 'vitest'
import {
  resolveImageGenerationsPath,
  buildImageRequestBody,
  parseImageResponseItems,
  parseProviderImageError,
  truncateForLog,
  MAX_ERROR_BODY_LOG,
  encodeInputImageValue,
  sanitizeImageBodyForLog,
  writeProviderPayloadField,
  resolveInputImages,
} from './OpenAIImageGenerationAdapter'
import { ImageGenerationError } from './imageGenerationErrors'
import type { ImageGenerationWireConfig, ImageGenerationInputImageMapping } from '../../shared/types/provider'

describe('resolveImageGenerationsPath', () => {
  it('uses custom path when provided', () => {
    expect(resolveImageGenerationsPath('https://api.example.com/v1', '/custom/images')).toBe('/custom/images')
  })

  it('appends /images/generations when baseUrl already ends with /v1', () => {
    expect(resolveImageGenerationsPath('https://api.example.com/v1')).toBe('/images/generations')
  })

  it('appends /v1/images/generations when baseUrl has no /v1', () => {
    expect(resolveImageGenerationsPath('https://api.example.com')).toBe('/v1/images/generations')
  })

  it('normalizes trailing slashes before checking /v1 suffix', () => {
    expect(resolveImageGenerationsPath('https://api.example.com/v1/')).toBe('/images/generations')
  })

  it('does not duplicate /v1 for custom tail paths', () => {
    const base = 'https://api.example.com/v1'
    const path = resolveImageGenerationsPath(base)
    expect(`${base}${path}`).toBe('https://api.example.com/v1/images/generations')
  })
})

describe('buildImageRequestBody', () => {
  it('always includes model, prompt and n', () => {
    const body = buildImageRequestBody({ model: 'gpt-image-1', prompt: 'a cat' })
    expect(body).toEqual({ model: 'gpt-image-1', prompt: 'a cat', n: 1 })
  })

  it('includes optional params only when provided', () => {
    const body = buildImageRequestBody({
      model: 'gpt-image-1',
      prompt: 'a dog',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      outputFormat: 'png',
    })
    expect(body).toEqual({
      model: 'gpt-image-1',
      prompt: 'a dog',
      n: 1,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
    })
  })

  it('maps outputFormat to output_format (snake_case) only when present', () => {
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', outputFormat: 'webp' })
    expect(body.output_format).toBe('webp')
    // 缺失时不上送该字段（Provider 默认）
    const body2 = buildImageRequestBody({ model: 'm', prompt: 'p' })
    expect((body2 as unknown as Record<string, unknown>).output_format).toBeUndefined()
  })

  it('omits every optional param when the Profile did not provide a value', () => {
    const body = buildImageRequestBody({ model: 'custom-image-model', prompt: 'a blue circle', n: 1 })
    expect(body).toEqual({ model: 'custom-image-model', prompt: 'a blue circle', n: 1 })
  })

  it('respects an explicit n and defaults to 1 otherwise', () => {
    expect(buildImageRequestBody({ model: 'm', prompt: 'p', n: 3 }).n).toBe(3)
    expect(buildImageRequestBody({ model: 'm', prompt: 'p' }).n).toBe(1)
  })

  it('omits empty-string optional params', () => {
    const body = buildImageRequestBody({
      model: 'm',
      prompt: 'p',
      size: '',
      quality: '',
      background: '',
      outputFormat: '',
    })
    expect(body).toEqual({ model: 'm', prompt: 'p', n: 1 })
  })
})

describe('buildImageRequestBody — image-to-image (requestMapping)', () => {
  const customWire: ImageGenerationWireConfig = {
    requestMapping: {
      inputImages: { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' },
      responseFormatParameter: { enabled: true, path: 'extra_body.response_format', valueType: 'string', value: 'b64_json' },
    },
  }

  it('places reference images under the mapped path, not at top level', () => {
    const body = buildImageRequestBody(
      { model: 'custom-image-to-image-model', prompt: 'make it orange', size: '1K', wire: customWire },
      ['data:image/png;base64,AAAA']
    )
    expect(body.extra_body?.image).toEqual(['data:image/png;base64,AAAA'])
    // 参考图绝不放在顶层
    expect((body as unknown as Record<string, unknown>).image).toBeUndefined()
    expect(body.size).toBe('1K')
    expect(body.model).toBe('custom-image-to-image-model')
  })

  it('sends response_format under extra_body (not top-level) and never mixes with output_format', () => {
    const body = buildImageRequestBody(
      { model: 'm', prompt: 'p', outputFormat: 'png', wire: customWire },
      ['data:image/png;base64,AAAA']
    )
    expect(body.extra_body?.response_format).toBe('b64_json')
    expect((body as unknown as Record<string, unknown>).response_format).toBeUndefined()
    // output_format 仍在顶层，且与 response_format 语义分离
    expect(body.output_format).toBe('png')
  })

  it('keeps reference image order (array cardinality)', () => {
    const body = buildImageRequestBody(
      { model: 'm', prompt: 'p', wire: customWire },
      ['data:image/png;base64,1', 'data:image/jpeg;base64,2']
    )
    expect(body.extra_body?.image).toEqual(['data:image/png;base64,1', 'data:image/jpeg;base64,2'])
  })

  it('single cardinality writes a single value, not an array', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: { inputImages: { path: 'extra_body.image', cardinality: 'single', encoding: 'data_url' } },
    }
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire }, ['data:image/png;base64,AAAA'])
    expect(body.extra_body?.image).toBe('data:image/png;base64,AAAA')
  })

  it('text-to-image (no images) sends no reference-image field', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: { inputImages: { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' } },
    }
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire })
    expect(body.extra_body).toBeUndefined()
    expect((body as unknown as Record<string, unknown>).image).toBeUndefined()
  })

  it('text-to-image still sends an enabled responseFormatParameter (it is not tied to images)', () => {
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire: customWire })
    expect(body.extra_body?.response_format).toBe('b64_json')
  })

  it('top-level input path puts images at the top level', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: { inputImages: { path: 'image', cardinality: 'array', encoding: 'data_url' } },
    }
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire }, ['data:image/png;base64,AAAA'])
    expect(body.image).toEqual(['data:image/png;base64,AAAA'])
    expect(body.extra_body?.image).toBeUndefined()
  })

  it('top-level response path puts response_format at the top level', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: {
        inputImages: { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' },
        responseFormatParameter: { enabled: true, path: 'response_format', valueType: 'string', value: 'url' },
      },
    }
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire }, ['data:image/png;base64,AAAA'])
    expect(body.response_format).toBe('url')
    expect(body.extra_body?.response_format).toBeUndefined()
  })

  it('boolean responseFormatParameter writes a boolean value', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: {
        responseFormatParameter: { enabled: true, path: 'extra_body.return_b64_json', valueType: 'boolean', value: true },
      },
    }
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire })
    expect(body.extra_body?.return_b64_json).toBe(true)
  })

  it('disabled responseFormatParameter sends nothing', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: { responseFormatParameter: { enabled: false, path: 'extra_body.response_format', valueType: 'string', value: 'b64_json' } },
    }
    const body = buildImageRequestBody({ model: 'm', prompt: 'p', wire })
    expect(body.extra_body).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it('rejects a malicious mapped path (prototype pollution)', () => {
    const wire: ImageGenerationWireConfig = {
      requestMapping: { inputImages: { path: '__proto__.polluted', cardinality: 'array', encoding: 'data_url' } },
    }
    expect(() => buildImageRequestBody({ model: 'm', prompt: 'p', wire }, ['data:image/png;base64,AAAA'])).toThrowError(ImageGenerationError)
  })
})

describe('encodeInputImageValue', () => {
  it('encodes bytes as a Data URI (the only local send form)', () => {
    const value = encodeInputImageValue(new Uint8Array([1, 2, 3]), 'image/png')
    expect(value).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
  })
})

describe('sanitizeImageBodyForLog (Base64 never leaks into logs)', () => {
  it('replaces reference image values with a summary in extra_body.image', () => {
    const body = buildImageRequestBody(
      { model: 'm', prompt: 'p', wire: { requestMapping: { inputImages: { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' } } } },
      ['data:image/png;base64,SECRETBASE64']
    )
    const safe = sanitizeImageBodyForLog(body, [{ value: 'data:image/png;base64,SECRETBASE64', mimeType: 'image/png', byteSize: 1234 }])
    const json = JSON.stringify(safe)
    expect(json).not.toContain('SECRETBASE64')
    expect(json).not.toContain('data:image/png;base64')
    expect(json).toContain('image/png')
    expect(json).toContain('1234 bytes')
    // prompt 也只保留长度
    expect(json).not.toContain('"prompt":"p"')
  })

  it('sanitizes top-level image arrays too', () => {
    const body = buildImageRequestBody(
      { model: 'm', prompt: 'p', wire: { requestMapping: { inputImages: { path: 'image', cardinality: 'array', encoding: 'data_url' } } } },
      ['data:image/jpeg;base64,SECRETBASE64']
    )
    const safe = sanitizeImageBodyForLog(body, [{ value: 'data:image/jpeg;base64,SECRETBASE64', mimeType: 'image/jpeg', byteSize: 42 }])
    const json = JSON.stringify(safe)
    expect(json).not.toContain('SECRETBASE64')
    expect(json).toContain('image/jpeg')
  })

  it('sanitizes a single-value Data URI (cardinality=single)', () => {
    const body = buildImageRequestBody(
      { model: 'm', prompt: 'p', wire: { requestMapping: { inputImages: { path: 'image', cardinality: 'single', encoding: 'data_url' } } } },
      ['data:image/png;base64,SECRETBASE64']
    )
    const safe = sanitizeImageBodyForLog(body, [{ value: 'data:image/png;base64,SECRETBASE64', mimeType: 'image/png', byteSize: 7 }])
    const json = JSON.stringify(safe)
    expect(json).not.toContain('SECRETBASE64')
    expect(json).toContain('7 bytes')
  })
})

describe('resolveInputImages (attachmentId → data URI, order preserved)', () => {
  const mapping: ImageGenerationInputImageMapping = { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' }
  const resolver = {
    resolveForGeneration: (id: string) => {
      if (id === 'missing') return null
      const map: Record<string, { bytes: Uint8Array; mimeType: string }> = {
        a1: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
        a2: { bytes: new Uint8Array([4, 5]), mimeType: 'image/jpeg' },
      }
      return map[id] ?? null
    },
  }

  it('no input images → text_to_image, nothing encoded', () => {
    const out = resolveInputImages([], mapping, resolver)
    expect(out.operation).toBe('text_to_image')
    expect(out.encoded).toEqual([])
  })

  it('single image → image_to_image with data URI', () => {
    const out = resolveInputImages([{ attachmentId: 'a1', mimeType: 'image/png' }], mapping, resolver)
    expect(out.operation).toBe('image_to_image')
    expect(out.encoded).toEqual([`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`])
    expect(out.resolved[0]).toEqual({ value: out.encoded[0], mimeType: 'image/png', byteSize: 3 })
  })

  it('multiple images → order preserved', () => {
    const out = resolveInputImages(
      [{ attachmentId: 'a1', mimeType: 'image/png' }, { attachmentId: 'a2', mimeType: 'image/jpeg' }],
      mapping,
      resolver
    )
    expect(out.encoded).toHaveLength(2)
    expect(out.encoded[0].startsWith('data:image/png')).toBe(true)
    expect(out.encoded[1].startsWith('data:image/jpeg')).toBe(true)
    expect(out.resolved.map((r) => r.byteSize)).toEqual([3, 2])
  })

  it('unreadable reference image throws (never silently falls back to text-to-image)', () => {
    expect(() => resolveInputImages([{ attachmentId: 'missing', mimeType: 'image/png' }], mapping, resolver)).toThrowError(ImageGenerationError)
  })

  it('missing mapping throws', () => {
    expect(() => resolveInputImages([{ attachmentId: 'a1', mimeType: 'image/png' }], undefined, resolver)).toThrowError(ImageGenerationError)
  })

  it('missing resolver throws', () => {
    expect(() => resolveInputImages([{ attachmentId: 'a1', mimeType: 'image/png' }], mapping, undefined)).toThrowError(ImageGenerationError)
  })
})

describe('writeProviderPayloadField', () => {
  it('writes to extra_body.<field> for two-segment paths', () => {
    const body = { model: 'm', prompt: 'p', n: 1 } as { extra_body?: Record<string, unknown> }
    writeProviderPayloadField(body as never, 'extra_body.images', ['x'])
    expect(body.extra_body?.images).toEqual(['x'])
  })

  it('writes a top-level field for one-segment paths', () => {
    const body = { model: 'm', prompt: 'p', n: 1 } as Record<string, unknown>
    writeProviderPayloadField(body as never, 'image', ['x'])
    expect(body.image).toEqual(['x'])
  })

  it('rejects nested/unknown/prototype paths', () => {
    const body = { model: 'm', prompt: 'p', n: 1 } as Record<string, unknown>
    expect(() => writeProviderPayloadField(body as never, 'a.b.c', ['x'])).toThrowError(ImageGenerationError)
    expect(() => writeProviderPayloadField(body as never, 'foo.bar', ['x'])).toThrowError(ImageGenerationError)
    expect(() => writeProviderPayloadField(body as never, '__proto__.polluted', ['x'])).toThrowError(ImageGenerationError)
  })
})

describe('parseImageResponseItems', () => {
  it('extracts items from { data: [...] } shape', () => {
    const items = parseImageResponseItems(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
    expect(items).toHaveLength(1)
    expect(items[0].b64_json).toBe('AAAA')
  })

  it('extracts items from a top-level array shape', () => {
    const items = parseImageResponseItems(JSON.stringify([{ url: 'https://x/y.png' }]))
    expect(items).toHaveLength(1)
    expect(items[0].url).toBe('https://x/y.png')
  })

  it('keeps revised_prompt', () => {
    const items = parseImageResponseItems(JSON.stringify({ data: [{ b64_json: 'A', revised_prompt: 'revised' }] }))
    expect(items[0].revised_prompt).toBe('revised')
  })

  it('throws INVALID_RESPONSE on unparseable JSON', () => {
    try {
      parseImageResponseItems('not json')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ImageGenerationError)
      expect((err as ImageGenerationError).code).toBe('IMAGE_GENERATION_INVALID_RESPONSE')
    }
  })

  it('throws INVALID_RESPONSE on empty data array', () => {
    expect(() => parseImageResponseItems(JSON.stringify({ data: [] }))).toThrowError(ImageGenerationError)
  })

  it('throws INVALID_RESPONSE when data is not an array', () => {
    expect(() => parseImageResponseItems(JSON.stringify({ data: null }))).toThrowError(ImageGenerationError)
  })
})

describe('parseProviderImageError', () => {
  it('extracts message/type/param/code from a standard error body', () => {
    const body = JSON.stringify({
      error: { message: 'output_format 不是文生图队列支持的字段', type: 'invalid_request', param: '', code: 'invalid_request' },
    })
    const parsed = parseProviderImageError(body)
    expect(parsed?.type).toBe('invalid_request')
    expect(parsed?.code).toBe('invalid_request')
    expect(parsed?.message).toContain('output_format')
  })

  it('returns null for non-error or unparseable bodies', () => {
    expect(parseProviderImageError('not json')).toBeNull()
    expect(parseProviderImageError(JSON.stringify({ data: [] }))).toBeNull()
    expect(parseProviderImageError('')).toBeNull()
  })
})

describe('truncateForLog', () => {
  it('returns short bodies unchanged', () => {
    expect(truncateForLog('hello')).toBe('hello')
  })

  it('truncates oversized bodies with a marker', () => {
    const big = 'x'.repeat(MAX_ERROR_BODY_LOG + 100)
    const out = truncateForLog(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out).toContain('truncated')
  })
})
