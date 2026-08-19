import * as crypto from 'crypto'

export interface PKCEParams {
  codeVerifier: string
  codeChallenge: string
  state: string
}

/**
 * 生成 PKCE S256 参数 + state
 * 使用 crypto.randomBytes（禁止 Math.random()）
 */
export function generatePKCEParams(): PKCEParams {
  // code_verifier: 32 bytes random → base64url → 43 chars (PKCE S256)
  const verifierBytes = crypto.randomBytes(32)
  const codeVerifier = base64urlEncode(verifierBytes)

  const codeChallenge = computeCodeChallenge(codeVerifier)

  // state: 32 bytes random → base64url
  const stateBytes = crypto.randomBytes(32)
  const state = base64urlEncode(stateBytes)

  return { codeVerifier, codeChallenge, state }
}

/**
 * BASE64URL(SHA256(code_verifier))
 */
export function computeCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest()
  return base64urlEncode(hash)
}

function base64urlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}