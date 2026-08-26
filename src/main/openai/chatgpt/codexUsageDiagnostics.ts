import type { OAuthCredentialManager } from './auth/OAuthCredentialManager'
import { createRequest } from './httpsClient'
import { redactSecrets } from './rateLimitDiagnostics'

const BASE_URL = 'https://chatgpt.com'

/**
 * 临时诊断：GET /backend-api/wham/usage
 * 仅用于 debug 操作，不改变聊天行为，不新增 API key。
 */
export async function fetchCodexUsage(credentialManager: OAuthCredentialManager): Promise<void> {
  const token = await credentialManager.getAccessToken()
  const accountId = await credentialManager.getAccountId()

  const url = `${BASE_URL}/backend-api/wham/usage`
  console.log('[Codex Usage] GET', url)

  await new Promise<void>((resolve) => {
    const parsedUrl = new URL(url)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (accountId) {
      headers['ChatGPT-Account-Id'] = accountId
    }

    const req = createRequest(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        protocol: 'https:',
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString()
        })
        res.on('end', () => {
          console.log('[Codex Usage] status:', res.statusCode)
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>
            // 提取重点字段，其余字段脱敏后完整打印
            const summary: Record<string, unknown> = {}
            const pick = (key: string) => {
              if (key in parsed) summary[key] = parsed[key]
            }
            pick('plan_type')
            pick('rate_limit')
            pick('primary_window')
            pick('secondary_window')
            pick('additional_rate_limits')
            pick('credits')
            pick('rate_limit_reached_type')
            pick('spend_control')

            console.log('[Codex Usage] keys:', Object.keys(parsed).join(', '))
            console.log('[Codex Usage] key-fields:', JSON.stringify(summary))
            console.log('[Codex Usage] full:', redactSecrets(JSON.stringify(parsed)))
          } catch {
            console.log('[Codex Usage] raw:', redactSecrets(data.slice(0, 4000)))
          }
          resolve()
        })
      }
    )

    req.on('error', (err) => {
      console.error('[Codex Usage] error:', err.message)
      resolve()
    })
    req.end()
  })
}
