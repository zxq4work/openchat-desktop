import { describe, it, expect } from 'vitest'
import { generatePKCEParams, computeCodeChallenge } from './pkce'

describe('pkce', () => {
  describe('generatePKCEParams', () => {
    it('generates code_verifier of 43 chars (base64url of 32 bytes)', () => {
      const params = generatePKCEParams()
      expect(params.codeVerifier).toHaveLength(43)
    })

    it('generates code_challenge of 43 chars (SHA256 digest base64url)', () => {
      const params = generatePKCEParams()
      expect(params.codeChallenge).toHaveLength(43)
    })

    it('generates state of 43 chars (base64url of 32 bytes)', () => {
      const params = generatePKCEParams()
      expect(params.state).toHaveLength(43)
    })

    it('produces consistent code_challenge from code_verifier', () => {
      const params = generatePKCEParams()
      const computed = computeCodeChallenge(params.codeVerifier)
      expect(computed).toBe(params.codeChallenge)
    })
  })

  describe('computeCodeChallenge', () => {
    it('is deterministic', () => {
      const verifier = 'abcdefghijklmnopqrstuvwxyz1234567890ABCD'
      expect(computeCodeChallenge(verifier)).toBe(computeCodeChallenge(verifier))
    })

    it('returns 43-character base64url string', () => {
      const verifier = 'abcdefghijklmnopqrstuvwxyz1234567890ABCD'
      const challenge = computeCodeChallenge(verifier)
      expect(challenge).toHaveLength(43)
    })
  })
})