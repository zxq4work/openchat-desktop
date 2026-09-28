import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  isRequestParamDebugEnabled,
  sanitizeScalarValue,
  summarizeRequestBody,
  formatResolvedDynamicParameters,
  logFinalRequestDebug,
} from './requestDebug'

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

describe('formatResolvedDynamicParameters', () => {
  it('prints the real string value instead of collapsing it', () => {
    const out = formatResolvedDynamicParameters([
      { id: 'custom-option', path: 'extra_body.custom_option', value: 'credential-value' },
    ])
    expect(out).toEqual([{ id: 'custom-option', path: 'extra_body.custom_option', value: 'credential-value' }])
    // 关键：不再退化为 <string length=N>
    expect(JSON.stringify(out)).toContain('credential-value')
  })

  it('keeps the real value for a long string (no length collapse)', () => {
    const long = 'example-secret-value-' + 'x'.repeat(200)
    const out = formatResolvedDynamicParameters([{ id: 's', path: 's', value: long }])
    expect(out[0].value).toBe(long)
  })

  it('keeps real number / boolean values', () => {
    const out = formatResolvedDynamicParameters([
      { id: 'steps', path: 'extra_body.steps', value: 40 },
      { id: 'flag', path: 'extra_body.flag', value: true },
    ])
    expect(out).toEqual([
      { id: 'steps', path: 'extra_body.steps', value: 40 },
      { id: 'flag', path: 'extra_body.flag', value: true },
    ])
  })

  it('serializes the dynamic parameters as readable JSON', () => {
    const out = formatResolvedDynamicParameters([
      { id: 'steps', path: 'extra_body.steps', value: 40 },
      { id: 'quality', path: 'extra_body.quality', value: 'high' },
    ])
    expect(JSON.parse(JSON.stringify(out))).toEqual([
      { id: 'steps', path: 'extra_body.steps', value: 40 },
      { id: 'quality', path: 'extra_body.quality', value: 'high' },
    ])
  })

  it('accepts an empty resolved list', () => {
    expect(formatResolvedDynamicParameters([])).toEqual([])
  })
})

describe('logFinalRequestDebug gating', () => {
  const original = process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
    else process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = original
    vi.restoreAllMocks()
  })

  it('prints nothing when the switch is off', () => {
    delete process.env.OPENCHAT_DEBUG_REQUEST_PARAMS
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logFinalRequestDebug('chat_completions', { model: 'x', extra_body: { steps: 40 } }, [{ id: 'steps', path: 'extra_body.steps', value: 40 }])
    expect(spy).not.toHaveBeenCalled()
  })

  it('prints the applied dynamic parameters with real values when on', () => {
    process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = '1'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logFinalRequestDebug('chat_completions', { model: 'x', extra_body: { custom: 'custom-value' } }, [
      { id: 'custom', path: 'extra_body.custom', value: 'custom-value' },
    ])
    const joined = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(joined).toContain('[RequestDebug]')
    expect(joined).toContain('custom-value')
    // 敏感字段仍由 body sanitizer 处理
    expect(joined).toContain('finalRequestShape')
  })

  it('still redacts secrets in the request body shape while on', () => {
    process.env.OPENCHAT_DEBUG_REQUEST_PARAMS = '1'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logFinalRequestDebug('chat_completions', { api_key: 'example-secret-value', prompt: 'x'.repeat(50) })
    const joined = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(joined).toContain('<redacted>')
    expect(joined).not.toContain('example-secret-value')
    expect(joined).toContain('promptLength=')
  })
})
