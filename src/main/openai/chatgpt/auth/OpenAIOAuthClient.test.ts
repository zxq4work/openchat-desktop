import { describe, it, expect } from 'vitest'

// JWT parsing tests for the extraction logic used in OpenAIOAuthClient
function extractAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split('.')
    if (parts.length < 2) return ''
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    const authClaim = payload['https://api.openai.com/auth']
    return authClaim?.chatgpt_account_id ?? ''
  } catch {
    return ''
  }
}

describe('OpenAIOAuthClient JWT parsing', () => {
  it('extracts accountId from a valid JWT', () => {
    const payload = {
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_test123',
      },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }

    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64')
    const token = `${header}.${body}.sig`

    expect(extractAccountId(token)).toBe('acct_test123')
  })

  it('returns empty string for missing claim', () => {
    const payload = { exp: Math.floor(Date.now() / 1000) + 3600 }
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64')
    const token = `${header}.${body}.sig`

    expect(extractAccountId(token)).toBe('')
  })

  it('returns empty string for malformed token', () => {
    expect(extractAccountId('not-a-jwt')).toBe('')
  })

  it('returns empty string for empty token', () => {
    expect(extractAccountId('')).toBe('')
  })
})