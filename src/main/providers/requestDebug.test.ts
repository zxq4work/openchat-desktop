import { describe, it, expect, afterEach } from 'vitest'
import { isRequestParamDebugEnabled, sanitizeScalarValue, summarizeRequestBody } from './requestDebug'

describe('isRequestParamDebugEnabled', () => {
  const original = process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
    else process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = original
  })

  it('is off by default', () => {
    delete process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
    expect(isRequestParamDebugEnabled()).toBe(false)
  })

  it('accepts 1 / true only', () => {
    process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = '1'
    expect(isRequestParamDebugEnabled()).toBe(true)
    process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = 'true'
    expect(isRequestParamDebugEnabled()).toBe(true)
    process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = 'yes'
    expect(isRequestParamDebugEnabled()).toBe(false)
  })
})

describe('sanitizeScalarValue', () => {
  it('passes through short scalars', () => {
    expect(sanitizeScalarValue(40)).toBe(40)
    expect(sanitizeScalarValue(true)).toBe(true)
    expect(sanitizeScalarValue('b64_json')).toBe('b64_json')
    expect(sanitizeScalarValue(null)).toBeNull()
  })

  it('replaces a data URL with a placeholder', () => {
    expect(sanitizeScalarValue('data:image/png;base64,AAAA')).toBe('<data-url omitted>')
  })

  it('summarizes long strings by length', () => {
    const long = 'x'.repeat(200)
    expect(sanitizeScalarValue(long)).toBe('<string length=200>')
  })

  it('summarizes a data-url array as an image count', () => {
    expect(sanitizeScalarValue(['data:image/png;base64,AA', 'data:image/png;base64,BB'])).toBe('<image array count=2>')
  })

  it('summarizes plain arrays / objects without dumping them', () => {
    expect(sanitizeScalarValue([1, 2, 3])).toBe('<array count=3>')
    expect(sanitizeScalarValue({ a: 1, b: 2 })).toBe('<object keys=2>')
  })
})

describe('summarizeRequestBody', () => {
  it('redacts secret-bearing keys', () => {
    const out = summarizeRequestBody({
      Authorization: 'Bearer abc',
      api_key: 'k',
      'API-KEY': 'k',
      token: 't',
      secret: 's',
      password: 'p',
      Cookie: 'c',
    })
    expect(out.Authorization).toBe('<redacted>')
    expect(out.api_key).toBe('<redacted>')
    expect(out['API-KEY']).toBe('<redacted>')
    expect(out.token).toBe('<redacted>')
    expect(out.secret).toBe('<redacted>')
    expect(out.password).toBe('<redacted>')
    expect(out.Cookie).toBe('<redacted>')
  })

  it('reports counts instead of contents for messages / tools / input', () => {
    const out = summarizeRequestBody({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{}, {}],
      input: [{}, {}, {}],
    })
    expect(out.messages).toBe('messagesCount=1')
    expect(out.tools).toBe('toolsCount=2')
    expect(out.input).toBe('inputCount=3')
  })

  it('reports prompt length only (never the prompt text)', () => {
    const out = summarizeRequestBody({ prompt: 'a very secret prompt' })
    expect(out.prompt).toBe('promptLength=20')
  })

  it('keeps safe scalars and summarizes a nested extra_body without dumping data URLs', () => {
    const out = summarizeRequestBody({
      model: 'x',
      n: 1,
      steps: 40,
      extra_body: { steps: 40, image: ['data:image/png;base64,AA'], foo: 'bar' },
    })
    expect(out.model).toBe('x')
    expect(out.n).toBe(1)
    expect(out.steps).toBe(40)
    expect(out.extra_body).toEqual({ steps: 40, image: '<image array count=1>', foo: 'bar' })
  })

  it('never leaks base64 in the JSON serialization', () => {
    const out = summarizeRequestBody({
      prompt: 'p',
      messages: new Array(100).fill({ role: 'user', content: 'x'.repeat(1000) }),
      extra_body: { image: 'data:image/png;base64,' + 'A'.repeat(5000) },
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain('AAAA')
    expect(json).toContain('<data-url omitted>')
  })
})
