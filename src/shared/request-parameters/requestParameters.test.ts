import { describe, it, expect } from 'vitest'
import {
  validateRequestPath,
  applyRequestField,
  RequestFieldError,
  getProtectedRequestPaths,
  isProtectedRequestPath,
  validateDefinition,
  validateValueAgainstType,
  validateRequestParameterProfile,
  resolveRequestParameters,
  resolveParameterValues,
  applyResolvedParameters,
  normalizeRequestParameterProfile,
  sanitizeParameterValues,
  findDuplicateResolvedPath,
  findReservedPathConflict,
  computeReservedRequestPaths,
  findDynamicParameterConflict,
  MAX_REQUEST_PARAMETERS,
} from './requestParameters'
import type {
  DynamicRequestParameterDefinition,
  RequestParameterProfile,
} from '../types/provider'

function def(patch: Partial<DynamicRequestParameterDefinition>): DynamicRequestParameterDefinition {
  const base: DynamicRequestParameterDefinition = {
    id: 'p',
    label: 'P',
    path: 'steps',
    type: 'number',
    placement: 'advanced',
  }
  return { ...base, ...patch }
}

describe('validateRequestPath', () => {
  it('accepts top-level field', () => {
    expect(validateRequestPath('steps')).toBeNull()
    expect(validateRequestPath('max_tokens')).toBeNull()
  })

  it('accepts extra_body.<field>', () => {
    expect(validateRequestPath('extra_body.num_inference_steps')).toBeNull()
  })

  it('rejects empty', () => {
    expect(validateRequestPath('')).not.toBeNull()
    expect(validateRequestPath('   ')).not.toBeNull()
  })

  it('rejects nested beyond two levels', () => {
    expect(validateRequestPath('a.b.c')).not.toBeNull()
  })

  it('rejects non-extra_body second level', () => {
    expect(validateRequestPath('foo.bar')).not.toBeNull()
  })

  it('rejects prototype pollution segments', () => {
    expect(validateRequestPath('__proto__')).not.toBeNull()
    expect(validateRequestPath('constructor')).not.toBeNull()
    expect(validateRequestPath('extra_body.prototype')).not.toBeNull()
    expect(validateRequestPath('extra_body.__proto__')).not.toBeNull()
  })

  it('rejects illegal characters', () => {
    expect(validateRequestPath('a-b')).not.toBeNull()
    expect(validateRequestPath('a b')).not.toBeNull()
    expect(validateRequestPath('1abc')).not.toBeNull()
  })
})

describe('applyRequestField', () => {
  it('writes top-level field', () => {
    const body: Record<string, unknown> = {}
    applyRequestField(body, 'steps', 20)
    expect(body).toEqual({ steps: 20 })
  })

  it('merges into extra_body without clobbering existing keys', () => {
    const body: Record<string, unknown> = { extra_body: { existing: 'keep' } }
    applyRequestField(body, 'extra_body.num_inference_steps', 30)
    expect(body.extra_body).toEqual({ existing: 'keep', num_inference_steps: 30 })
  })

  it('creates extra_body when absent', () => {
    const body: Record<string, unknown> = {}
    applyRequestField(body, 'extra_body.foo', true)
    expect(body.extra_body).toEqual({ foo: true })
  })

  it('throws when extra_body exists but is not an object', () => {
    const body: Record<string, unknown> = { extra_body: 'oops' }
    expect(() => applyRequestField(body, 'extra_body.foo', 1)).toThrow(RequestFieldError)
  })

  it('throws on illegal path', () => {
    expect(() => applyRequestField({}, 'a.b.c', 1)).toThrow(RequestFieldError)
  })

  it('does not pollute Object.prototype', () => {
    applyRequestField({}, 'extra_body.legit', 1)
    expect(({} as Record<string, unknown>).legit).toBeUndefined()
  })
})

describe('protected paths', () => {
  it('protects model/stream for all protocols', () => {
    for (const p of ['chat_completions', 'responses', 'image_generations'] as const) {
      expect(getProtectedRequestPaths(p).has('model')).toBe(true)
      expect(getProtectedRequestPaths(p).has('stream')).toBe(true)
    }
  })

  it('protects protocol-specific fields', () => {
    expect(isProtectedRequestPath('chat_completions', 'messages')).toBe(true)
    expect(isProtectedRequestPath('responses', 'input')).toBe(true)
    expect(isProtectedRequestPath('image_generations', 'prompt')).toBe(true)
  })

  it('treats extra_body.<protected> the same as top-level', () => {
    expect(isProtectedRequestPath('chat_completions', 'extra_body.messages')).toBe(true)
  })

  it('does not protect arbitrary fields', () => {
    expect(isProtectedRequestPath('chat_completions', 'temperature')).toBe(false)
    expect(isProtectedRequestPath('chat_completions', 'extra_body.foo')).toBe(false)
  })
})

describe('validateDefinition', () => {
  it('accepts a valid definition', () => {
    expect(validateDefinition(def({}))).toBeNull()
  })

  it('rejects missing id / label', () => {
    expect(validateDefinition(def({ id: '' }))).not.toBeNull()
    expect(validateDefinition(def({ label: '  ' }))).not.toBeNull()
  })

  it('rejects invalid path', () => {
    expect(validateDefinition(def({ path: 'a.b.c' }))).not.toBeNull()
  })

  it('rejects min > max', () => {
    expect(validateDefinition(def({ min: 10, max: 5 }))).not.toBeNull()
  })

  it('rejects non-positive step', () => {
    expect(validateDefinition(def({ step: 0 }))).not.toBeNull()
    expect(validateDefinition(def({ step: -1 }))).not.toBeNull()
  })

  it('rejects select without options', () => {
    expect(validateDefinition(def({ type: 'select', options: [] }))).not.toBeNull()
  })

  it('rejects hidden without fixedValue', () => {
    expect(validateDefinition(def({ placement: 'hidden' }))).not.toBeNull()
  })

  it('accepts hidden with fixedValue of matching type', () => {
    expect(validateDefinition(def({ placement: 'hidden', fixedValue: 5 }))).toBeNull()
  })

  it('rejects hidden with fixedValue of wrong type', () => {
    expect(validateDefinition(def({ placement: 'hidden', fixedValue: 'oops' }))).not.toBeNull()
  })

  it('rejects duplicate select option values', () => {
    expect(validateDefinition(def({
      type: 'select',
      options: [{ label: 'a', value: 'x' }, { label: 'b', value: 'x' }],
    }))).not.toBeNull()
  })
})

describe('validateValueAgainstType', () => {
  it('number: type, min, max', () => {
    expect(validateValueAgainstType(def({}), 5)).toBeNull()
    expect(validateValueAgainstType(def({}), '5')).not.toBeNull()
    expect(validateValueAgainstType(def({}), NaN)).not.toBeNull()
    expect(validateValueAgainstType(def({ min: 3 }), 2)).not.toBeNull()
    expect(validateValueAgainstType(def({ max: 3 }), 4)).not.toBeNull()
  })

  it('number: step alignment including floats', () => {
    expect(validateValueAgainstType(def({ step: 5 }), 15)).toBeNull()
    expect(validateValueAgainstType(def({ step: 5 }), 7)).not.toBeNull()
    expect(validateValueAgainstType(def({ step: 0.1 }), 0.3)).toBeNull()
  })

  it('boolean', () => {
    expect(validateValueAgainstType(def({ type: 'boolean' }), true)).toBeNull()
    expect(validateValueAgainstType(def({ type: 'boolean' }), 'true')).not.toBeNull()
  })

  it('string', () => {
    expect(validateValueAgainstType(def({ type: 'string' }), 'x')).toBeNull()
    expect(validateValueAgainstType(def({ type: 'string' }), 1)).not.toBeNull()
  })

  it('select requires exact type+value match', () => {
    const d = def({ type: 'select', options: [{ label: 'a', value: 1 }] })
    expect(validateValueAgainstType(d, 1)).toBeNull()
    expect(validateValueAgainstType(d, '1')).not.toBeNull()
    expect(validateValueAgainstType(d, 2)).not.toBeNull()
  })
})

describe('validateRequestParameterProfile', () => {
  const profile = (params: DynamicRequestParameterDefinition[], overrides?: RequestParameterProfile['modelOverrides']): RequestParameterProfile => ({
    version: 1,
    providerParameters: params,
    ...(overrides ? { modelOverrides: overrides } : {}),
  })

  it('accepts empty / undefined', () => {
    expect(validateRequestParameterProfile(undefined, 'chat_completions')).toBeNull()
    expect(validateRequestParameterProfile(profile([]), 'chat_completions')).toBeNull()
  })

  it('rejects duplicate ids within provider scope', () => {
    expect(validateRequestParameterProfile(
      profile([def({ id: 'dup', path: 'a' }), def({ id: 'dup', path: 'b' })]),
      'chat_completions'
    )).not.toBeNull()
  })

  it('rejects duplicate paths within provider scope', () => {
    expect(validateRequestParameterProfile(
      profile([def({ id: 'a', path: 'steps' }), def({ id: 'b', path: 'steps' })]),
      'chat_completions'
    )).not.toBeNull()
  })

  it('rejects a param pointing at a protected core field', () => {
    expect(validateRequestParameterProfile(
      profile([def({ id: 'm', path: 'messages', type: 'string' })]),
      'chat_completions'
    )).not.toBeNull()
    expect(validateRequestParameterProfile(
      profile([def({ id: 'p', path: 'prompt', type: 'string' })]),
      'image_generations'
    )).not.toBeNull()
  })

  it('allows the same path in different scopes (provider vs model)', () => {
    expect(validateRequestParameterProfile(
      profile(
        [def({ id: 'steps', path: 'steps' })],
        { 'model-a': { parameters: [def({ id: 'steps', path: 'steps' })] } }
      ),
      'chat_completions'
    )).toBeNull()
  })

  it('rejects exceeding MAX_REQUEST_PARAMETERS', () => {
    const many = Array.from({ length: MAX_REQUEST_PARAMETERS + 1 }, (_, i) =>
      def({ id: `p${i}`, path: `field${i}` })
    )
    expect(validateRequestParameterProfile(profile(many), 'chat_completions')).not.toBeNull()
  })
})

describe('resolveRequestParameters', () => {
  const provider = [
    def({ id: 'steps', path: 'steps', label: 'Steps' }),
    def({ id: 'seed', path: 'seed', label: 'Seed' }),
  ]

  it('returns [] for undefined profile', () => {
    expect(resolveRequestParameters(undefined, 'm')).toEqual([])
  })

  it('returns provider-level when no override', () => {
    const result = resolveRequestParameters({ version: 1, providerParameters: provider }, 'm')
    expect(result.map((d) => d.id)).toEqual(['steps', 'seed'])
  })

  it('override replaces same id in place (stable order)', () => {
    const result = resolveRequestParameters({
      version: 1,
      providerParameters: provider,
      modelOverrides: { m: { parameters: [def({ id: 'steps', path: 'steps', label: 'Steps!' })] } },
    }, 'm')
    expect(result.map((d) => d.id)).toEqual(['steps', 'seed'])
    expect(result[0].label).toBe('Steps!')
  })

  it('disabledParameterIds removes from result', () => {
    const result = resolveRequestParameters({
      version: 1,
      providerParameters: provider,
      modelOverrides: { m: { disabledParameterIds: ['seed'] } },
    }, 'm')
    expect(result.map((d) => d.id)).toEqual(['steps'])
  })

  it('model-only params appended after provider params', () => {
    const result = resolveRequestParameters({
      version: 1,
      providerParameters: provider,
      modelOverrides: { m: { parameters: [def({ id: 'guidance', path: 'guidance' })] } },
    }, 'm')
    expect(result.map((d) => d.id)).toEqual(['steps', 'seed', 'guidance'])
  })

  it('non-overridden model gets provider-level', () => {
    const result = resolveRequestParameters({
      version: 1,
      providerParameters: provider,
      modelOverrides: { other: { disabledParameterIds: ['seed'] } },
    }, 'm')
    expect(result.map((d) => d.id)).toEqual(['steps', 'seed'])
  })
})

describe('resolveParameterValues + applyResolvedParameters', () => {
  it('omits unset params entirely (never sends defaults)', () => {
    const { resolved, error } = resolveParameterValues([def({ id: 'steps', path: 'steps' })], {})
    expect(error).toBeNull()
    expect(resolved).toEqual([])
  })

  it('includes only set params', () => {
    const defs = [def({ id: 'steps', path: 'steps' }), def({ id: 'seed', path: 'seed' })]
    const { resolved } = resolveParameterValues(defs, { steps: 20 })
    expect(resolved).toEqual([{ id: 'steps', path: 'steps', value: 20 }])
  })

  it('hidden param always sends fixedValue even when unset', () => {
    const { resolved } = resolveParameterValues(
      [def({ id: 'foot', path: 'extra_body.foot', placement: 'hidden', type: 'boolean', fixedValue: true })],
      {}
    )
    expect(resolved).toEqual([{ id: 'foot', path: 'extra_body.foot', value: true }])
  })

  it('errors on invalid set value', () => {
    const { error } = resolveParameterValues([def({ id: 'steps', path: 'steps', min: 5 })], { steps: 1 })
    expect(error).not.toBeNull()
  })

  it('errors on protected path (defense in depth)', () => {
    const { error } = resolveParameterValues(
      [{ ...def({ id: 'm', path: 'messages', type: 'string' }), path: 'messages' }],
      { m: 'x' },
      'chat_completions'
    )
    expect(error).not.toBeNull()
  })

  it('required param unset → error', () => {
    const { error } = resolveParameterValues([def({ id: 'r', path: 'r', required: true })], {})
    expect(error).not.toBeNull()
  })

  it('applies top-level and merged extra_body', () => {
    const body: Record<string, unknown> = { model: 'x', extra_body: { keep: 1 } }
    applyResolvedParameters(body, [
      { id: 'steps', path: 'steps', value: 20 },
      { id: 'foot', path: 'extra_body.foot', value: true },
    ])
    expect(body).toEqual({ model: 'x', steps: 20, extra_body: { keep: 1, foot: true } })
  })
})

describe('extra_body merge / conflict (audit item 7)', () => {
  it('merges into existing extra_body instead of overwriting it', () => {
    const body: Record<string, unknown> = { extra_body: { input_images: ['x'] } }
    applyResolvedParameters(body, [{ id: 'steps', path: 'extra_body.steps', value: 40 }])
    expect(body.extra_body).toEqual({ input_images: ['x'], steps: 40 })
  })

  it('throws when the target field is already occupied (no last-write-wins)', () => {
    const body: Record<string, unknown> = { extra_body: { steps: 20 } }
    expect(() => applyResolvedParameters(body, [{ id: 'steps', path: 'extra_body.steps', value: 40 }])).toThrow(RequestFieldError)
  })

  it('throws when a top-level target is already occupied', () => {
    const body: Record<string, unknown> = { model: 'x' }
    expect(() => applyResolvedParameters(body, [{ id: 'm', path: 'model', value: 'y' }])).toThrow(RequestFieldError)
  })
})

describe('stale conversation values / override revalidation (audit item 2, 3)', () => {
  // 危险场景：Provider id=output type=number path=max_tokens；
  // Model override 同 id=output type=select path=max_output_tokens；
  // 会话里旧值 output=4096（当时 number 合法）→ 必须按新 select 定义重新校验，而不是按 id 信任旧值。
  const providerOutput = def({ id: 'output', path: 'max_tokens', type: 'number', label: 'Max tokens' })
  const modelOutput = def({
    id: 'output',
    path: 'max_output_tokens',
    type: 'select',
    label: 'Max output tokens',
    options: [{ label: '1024', value: 1024 }, { label: '2048', value: 2048 }],
  })
  const profile: RequestParameterProfile = {
    version: 1,
    providerParameters: [providerOutput],
    modelOverrides: { 'm1': { parameters: [modelOutput] } },
  }

  it('resolves the override definition (same id, new path/type)', () => {
    const defs = resolveRequestParameters(profile, 'm1')
    expect(defs).toHaveLength(1)
    expect(defs[0].path).toBe('max_output_tokens')
    expect(defs[0].type).toBe('select')
  })

  it('rejects a stale value that is invalid against the new definition', () => {
    const defs = resolveRequestParameters(profile, 'm1')
    const { resolved, error } = resolveParameterValues(defs, { output: 4096 }, 'chat_completions')
    expect(resolved).toEqual([])
    expect(error).not.toBeNull()
  })

  it('accepts a value valid against the new definition', () => {
    const defs = resolveRequestParameters(profile, 'm1')
    const { resolved, error } = resolveParameterValues(defs, { output: 2048 }, 'chat_completions')
    expect(error).toBeNull()
    expect(resolved).toEqual([{ id: 'output', path: 'max_output_tokens', value: 2048 }])
  })

  it('ignores values whose id no longer exists in the resolved definitions', () => {
    const defs = resolveRequestParameters(
      { version: 1, providerParameters: [def({ id: 'steps', path: 'steps' })] },
      'm1'
    )
    const { resolved, error } = resolveParameterValues(defs, { removedParam: 5 }, 'chat_completions')
    expect(error).toBeNull()
    expect(resolved).toEqual([])
  })
})

describe('duplicate / reserved path detection after merge (audit item 4, 5, 6)', () => {
  it('findDuplicateResolvedPath reports the clashing ids', () => {
    const dup = findDuplicateResolvedPath([
      { id: 'a', path: 'foo', value: 1 },
      { id: 'b', path: 'foo', value: 2 },
    ])
    expect(dup).toEqual({ path: 'foo', ids: ['a', 'b'] })
  })

  it('findDuplicateResolvedPath returns null when paths are unique', () => {
    expect(findDuplicateResolvedPath([
      { id: 'a', path: 'foo', value: 1 },
      { id: 'b', path: 'bar', value: 2 },
    ])).toBeNull()
  })

  it('findReservedPathConflict flags a dynamic param hitting a reserved path', () => {
    expect(findReservedPathConflict([{ id: 'img', path: 'extra_body.image', value: 'x' }], ['extra_body.image']))
      .toEqual({ path: 'extra_body.image', id: 'img' })
    expect(findReservedPathConflict([{ id: 'steps', path: 'steps', value: 1 }], ['extra_body.image'])).toBeNull()
  })

  it('profile validation rejects a merge that duplicates a path across scopes', () => {
    // Provider B→foo + override A→foo（不同 id）：各层合法，合并冲突。
    const err = validateRequestParameterProfile(
      {
        version: 1,
        providerParameters: [def({ id: 'b', path: 'foo' })],
        modelOverrides: { m1: { parameters: [def({ id: 'a', path: 'foo' })] } },
      },
      'chat_completions'
    )
    expect(err).not.toBeNull()
  })

  it('profile validation rejects a dynamic param using an image-reserved path', () => {
    const err = validateRequestParameterProfile(
      { version: 1, providerParameters: [def({ id: 'img', path: 'extra_body.image' })] },
      'image_generations',
      ['extra_body.image', 'response_format']
    )
    expect(err).not.toBeNull()
  })
})

describe('computeReservedRequestPaths + findDynamicParameterConflict (audit item 5, 6)', () => {
  it('always reserves model/stream and protocol core fields', () => {
    const chat = computeReservedRequestPaths('chat_completions')
    expect(chat.has('model')).toBe(true)
    expect(chat.has('stream')).toBe(true)
    expect(chat.has('messages')).toBe(true)
    expect(chat.has('reasoning_effort')).toBe(true)
    const resp = computeReservedRequestPaths('responses')
    expect(resp.has('input')).toBe(true)
    expect(resp.has('instructions')).toBe(true)
    expect(resp.has('reasoning')).toBe(true)
  })

  it('adds the image requestMapping paths (input images + response_format)', () => {
    const reserved = computeReservedRequestPaths('image_generations', {
      requestMapping: {
        inputImages: { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' },
        responseFormatParameter: { enabled: true, path: 'response_format', valueType: 'string', value: 'b64_json' },
      },
    } as never)
    expect(reserved.has('extra_body.image')).toBe(true)
    expect(reserved.has('response_format')).toBe(true)
  })

  it('does not reserve response_format when the mapping is disabled', () => {
    const reserved = computeReservedRequestPaths('image_generations', {
      requestMapping: {
        responseFormatParameter: { enabled: false, path: 'response_format', valueType: 'string', value: 'b64_json' },
      },
    } as never)
    expect(reserved.has('response_format')).toBe(false)
  })

  it('flags a duplicate resolved path first', () => {
    const msg = findDynamicParameterConflict(
      [{ id: 'a', path: 'foo', value: 1 }, { id: 'b', path: 'foo', value: 2 }],
      new Set(['foo'])
    )
    expect(msg).not.toBeNull()
    expect(msg).toContain('「a」')
  })

  it('flags a reserved-path conflict', () => {
    const msg = findDynamicParameterConflict([{ id: 'img', path: 'extra_body.image', value: 'x' }], new Set(['extra_body.image']))
    expect(msg).not.toBeNull()
    expect(msg).toContain('img')
  })

  it('returns null when there is no conflict', () => {
    expect(findDynamicParameterConflict([{ id: 'steps', path: 'extra_body.steps', value: 40 }], new Set(['extra_body.image']))).toBeNull()
  })
})

describe('hidden fixedValue authority (audit item 9)', () => {
  it('fixedValue wins over a conversation-provided value', () => {
    const { resolved } = resolveParameterValues(
      [def({ id: 'foot', path: 'extra_body.foot', placement: 'hidden', type: 'boolean', fixedValue: true })],
      { foot: false }
    )
    expect(resolved).toEqual([{ id: 'foot', path: 'extra_body.foot', value: true }])
  })
})

describe('unset omits the field entirely (audit item 10)', () => {
  it('does not write any key when the value is absent', () => {
    const body: Record<string, unknown> = { model: 'x' }
    const { resolved } = resolveParameterValues([def({ id: 'steps', path: 'steps' })], {})
    applyResolvedParameters(body, resolved)
    expect(Object.prototype.hasOwnProperty.call(body, 'steps')).toBe(false)
    expect(body).toEqual({ model: 'x' })
  })

  it('sanitizeParameterValues drops unknown ids and invalid values', () => {
    const defs = [def({ id: 'steps', path: 'steps', min: 1 })]
    expect(sanitizeParameterValues(defs, { steps: 20, gone: 5 })).toEqual({ steps: 20 })
    expect(sanitizeParameterValues(defs, { steps: 0 })).toEqual({})
  })
})

describe('no-profile zero regression (audit item 11)', () => {
  it('undefined profile-resolved params leave the body byte-identical', () => {
    const body: Record<string, unknown> = { model: 'x', messages: [], stream: true }
    const snapshot = JSON.stringify(body)
    const { resolved, error } = resolveParameterValues(resolveRequestParameters(undefined, 'm'), {})
    expect(error).toBeNull()
    applyResolvedParameters(body, resolved)
    expect(JSON.stringify(body)).toBe(snapshot)
  })
})

describe('Model A/B isolation (audit item 12)', () => {
  const profile: RequestParameterProfile = {
    version: 1,
    providerParameters: [def({ id: 'steps', path: 'steps', type: 'number', label: 'Steps' })],
    modelOverrides: {
      'model-a': { parameters: [def({ id: 'guidance', path: 'guidance_scale', type: 'number' })] },
      'model-b': { parameters: [def({ id: 'seed', path: 'seed', type: 'number' })] },
    },
  }

  it('model-a sees its own override only', () => {
    expect(resolveRequestParameters(profile, 'model-a').map((d) => d.id)).toEqual(['steps', 'guidance'])
  })

  it('model-b sees its own override only', () => {
    expect(resolveRequestParameters(profile, 'model-b').map((d) => d.id)).toEqual(['steps', 'seed'])
  })

  it('an unknown model sees provider-level only', () => {
    expect(resolveRequestParameters(profile, 'model-c').map((d) => d.id)).toEqual(['steps'])
  })
})

describe('generic image foot param (audit item 12)', () => {
  it('injects extra_body.steps for image_generations without touching core fields', () => {
    const body: Record<string, unknown> = { model: 'img', prompt: 'cat', n: 1 }
    applyResolvedParameters(body, [{ id: 'steps', path: 'extra_body.steps', value: 40 }])
    expect(body).toEqual({ model: 'img', prompt: 'cat', n: 1, extra_body: { steps: 40 } })
  })
})

describe('normalizeRequestParameterProfile (tolerant deserialization)', () => {
  it('returns undefined for empty / invalid input', () => {
    expect(normalizeRequestParameterProfile(null)).toBeUndefined()
    expect(normalizeRequestParameterProfile({})).toBeUndefined()
    expect(normalizeRequestParameterProfile({ providerParameters: [] })).toBeUndefined()
  })

  it('drops definitions with an illegal path', () => {
    const result = normalizeRequestParameterProfile({
      providerParameters: [
        { id: 'good', label: 'Good', path: 'steps', type: 'number', placement: 'advanced' },
        { id: 'bad', label: 'Bad', path: '__proto__', type: 'string', placement: 'advanced' },
      ],
    })
    expect(result?.providerParameters.map((d) => d.id)).toEqual(['good'])
  })

  it('keeps valid model overrides, drops empty ones', () => {
    const result = normalizeRequestParameterProfile({
      providerParameters: [{ id: 'steps', label: 'Steps', path: 'steps', type: 'number', placement: 'advanced' }],
      modelOverrides: {
        m1: { disabledParameterIds: ['steps'] },
        m2: {},
      },
    })
    expect(Object.keys(result?.modelOverrides ?? {})).toEqual(['m1'])
  })
})
