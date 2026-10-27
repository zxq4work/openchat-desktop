import { describe, it, expect } from 'vitest'
import { mapAnthropicHttpError, AnthropicApiError } from './AnthropicErrorMapper'

describe('mapAnthropicHttpError', () => {
  it('maps 401 auth error', () => {
    const m = mapAnthropicHttpError(401, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' }, request_id: 'req_1' }))
    expect(m.code).toBe('ANTHROPIC_AUTH_ERROR')
    expect(m.status).toBe(401)
    expect(m.requestId).toBe('req_1')
    expect(m.retryable).toBe(false)
  })

  it('maps 429 rate limit and retry-after', () => {
    const m = mapAnthropicHttpError(429, JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }), { 'retry-after': '30' })
    expect(m.code).toBe('ANTHROPIC_RATE_LIMITED')
    expect(m.retryAfter).toBe('30')
    expect(m.retryable).toBe(true)
  })

  it('maps 529 overloaded', () => {
    const m = mapAnthropicHttpError(529, JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } }))
    expect(m.code).toBe('ANTHROPIC_OVERLOADED')
    expect(m.retryable).toBe(true)
  })

  it('maps 400 invalid request as non-retryable', () => {
    const m = mapAnthropicHttpError(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }))
    expect(m.code).toBe('ANTHROPIC_INVALID_REQUEST')
    expect(m.retryable).toBe(false)
  })

  it('maps 404 not found', () => {
    const m = mapAnthropicHttpError(404, JSON.stringify({ error: { type: 'not_found_error', message: 'no model' } }))
    expect(m.code).toBe('ANTHROPIC_NOT_FOUND')
  })

  it('tolerates non-JSON / plain-text gateway errors', () => {
    const m = mapAnthropicHttpError(502, '<html>Bad Gateway</html>')
    expect(m.code).toBe('ANTHROPIC_SERVER_ERROR')
    expect(m.message).toContain('Bad Gateway')
    expect(m.retryable).toBe(true)
  })

  it('treats null status (network) as retryable', () => {
    const m = mapAnthropicHttpError(null, '')
    expect(m.code).toBe('ANTHROPIC_NETWORK_ERROR')
    expect(m.retryable).toBe(true)
  })

  it('reads array-valued retry-after header', () => {
    const m = mapAnthropicHttpError(429, '', { 'Retry-After': ['10'] })
    expect(m.retryAfter).toBe('10')
  })

  it('AnthropicApiError carries code/status and a message with the error type', () => {
    const m = mapAnthropicHttpError(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'unsupported tool: x' } }))
    const err = new AnthropicApiError(m)
    expect(err.code).toBe('ANTHROPIC_INVALID_REQUEST')
    expect(err.status).toBe(400)
    expect(err.message.toLowerCase()).toContain('unsupported tool')
    expect(err.message).toContain('ANTHROPIC_INVALID_REQUEST')
  })
})