import { describe, it, expect } from 'vitest'
import {
  resolveAnthropicMessagesUrl,
  isSamplingParamsRemoved,
  toAnthropicEffort,
  ANTHROPIC_DEFAULT_VERSION,
} from './anthropicEndpoint'

describe('resolveAnthropicMessagesUrl', () => {
  it('appends /v1/messages to a bare host', () => {
    expect(resolveAnthropicMessagesUrl('https://host.example')).toBe('https://host.example/v1/messages')
  })

  it('normalizes trailing slash', () => {
    expect(resolveAnthropicMessagesUrl('https://host.example/')).toBe('https://host.example/v1/messages')
  })

  it('base already ending with /v1 → /v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://host.example/v1')).toBe('https://host.example/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://host.example/v1/')).toBe('https://host.example/v1/messages')
  })

  it('full /v1/messages stays unchanged (no /v1/v1 or /messages/messages)', () => {
    expect(resolveAnthropicMessagesUrl('https://host.example/v1/messages')).toBe('https://host.example/v1/messages')
  })

  it('preserves reverse-proxy path prefix', () => {
    expect(resolveAnthropicMessagesUrl('https://host.example/anthropic')).toBe('https://host.example/anthropic/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://host.example/anthropic/v1')).toBe('https://host.example/anthropic/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://host.example/anthropic/v1/messages')).toBe('https://host.example/anthropic/v1/messages')
  })

  it('preserves port and protocol', () => {
    expect(resolveAnthropicMessagesUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://host.example:8443/v1')).toBe('https://host.example:8443/v1/messages')
  })

  it('keeps query params on endpoint override untouched', () => {
    expect(resolveAnthropicMessagesUrl('https://host.example', 'https://proxy/messages?x=1')).toBe('https://proxy/messages?x=1')
  })

  it('endpoint override is authoritative, base path not appended', () => {
    expect(resolveAnthropicMessagesUrl('https://ignored.example/v1', 'https://real.example/custom/messages')).toBe('https://real.example/custom/messages')
  })

  it('returns null for invalid urls', () => {
    expect(resolveAnthropicMessagesUrl('not a url')).toBeNull()
    expect(resolveAnthropicMessagesUrl('')).toBeNull()
  })

  it('never produces /v1/v1 or /messages/messages', () => {
    for (const input of ['https://h/v1', 'https://h/v1/', 'https://h/v1/messages', 'https://h/v1/messages/']) {
      const url = resolveAnthropicMessagesUrl(input)!
      expect(url).not.toContain('/v1/v1')
      expect(url).not.toContain('/messages/messages')
    }
  })
})

describe('isSamplingParamsRemoved', () => {
  it('2026-10-21 removes sampling params', () => {
    expect(isSamplingParamsRemoved('2026-10-21')).toBe(true)
  })

  it('default / unknown / empty keep sampling params', () => {
    expect(isSamplingParamsRemoved(ANTHROPIC_DEFAULT_VERSION)).toBe(false)
    expect(isSamplingParamsRemoved('')).toBe(false)
    expect(isSamplingParamsRemoved(undefined)).toBe(false)
    expect(isSamplingParamsRemoved('2024-01-01')).toBe(false)
  })
})

describe('toAnthropicEffort', () => {
  it('passes through supported efforts', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(toAnthropicEffort(e)).toBe(e)
    }
  })

  it('maps minimal → low (Anthropic has no lower tier), never emits "minimal"', () => {
    expect(toAnthropicEffort('minimal')).toBe('low')
  })

  it('returns null for none / empty / unknown', () => {
    expect(toAnthropicEffort('none')).toBeNull()
    expect(toAnthropicEffort('')).toBeNull()
    expect(toAnthropicEffort(null)).toBeNull()
    expect(toAnthropicEffort(undefined)).toBeNull()
    expect(toAnthropicEffort('ultra')).toBeNull()
  })

  it('is case/space tolerant', () => {
    expect(toAnthropicEffort(' HIGH ')).toBe('high')
    expect(toAnthropicEffort(' Minimal ')).toBe('low')
  })
})