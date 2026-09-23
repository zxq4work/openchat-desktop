import { describe, it, expect, vi } from 'vitest'

// ChatGPTCodexClient 依赖链会触达 httpsClient 的 electron net/session。
// 本测试以最小桩替代网络层，不发起任何真实网络调用。
vi.mock('electron', () => ({
  net: {},
  session: { defaultSession: { resolveProxy: vi.fn(), closeAllConnections: vi.fn(), forceReloadProxyConfig: vi.fn() } },
}))

// 桩掉 createRequest：记录每次请求的 client_version，并按脚本返回状态/body。
// 用于验证真实 listModels() 在 discovery 模式下「只请求一次 sentinel」。
const netStub = vi.hoisted(() => ({
  responses: [] as Array<{ status: number; body: string }>,
  requestedVersions: [] as string[],
  callIndex: 0,
}))

vi.mock('../httpsClient', () => ({
  createRequest: (options: { path?: string }, cb: (res: unknown) => void) => {
    const query = (options.path ?? '').split('?')[1] ?? ''
    netStub.requestedVersions.push(new URLSearchParams(query).get('client_version') ?? '')
    const response = netStub.responses[netStub.callIndex++] ?? { status: 500, body: '' }
    setTimeout(() => {
      cb({
        statusCode: response.status,
        headers: {},
        on: (event: string, handler: (chunk?: string) => void) => {
          if (event === 'data') setTimeout(() => handler(response.body), 0)
          else if (event === 'end') setTimeout(() => handler(), 0)
        },
      })
    }, 0)
    return { write: () => {}, end: () => {}, destroy: () => {}, on: () => {} }
  },
}))

import {
  buildModelsCatalogUrl,
  buildResponsesUrl,
  buildResponsesHeaders,
  buildResponsesBody,
  isKnownSSEEventType,
  summarizeResponsesShape,
  RealChatGPTCodexClient,
} from './ChatGPTCodexClient'
import type { OAuthCredentialManager } from '../auth/OAuthCredentialManager'
import { CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL } from '../models/modelCatalogDiscovery'
import { CODEX_VERSION } from '../../../../shared/constants'
import { ResponsesStreamParser } from './ResponsesStreamParser'

describe('catalog discovery', () => {
  it('TEST 1: /models URL uses the discovery sentinel query', () => {
    expect(buildModelsCatalogUrl(CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL))
      .toBe('https://chatgpt.com/backend-api/codex/models?client_version=99.99.99')
  })

  it('TEST 2: discovery sentinel has no dependency on CODEX_VERSION', () => {
    expect(CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL).not.toBe(CODEX_VERSION)
    expect(CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL).toBe('99.99.99')
    expect(CODEX_VERSION).toBe('0.148.0')
  })

  it('TEST 13: /responses URL carries NO client_version', () => {
    const url = buildResponsesUrl()
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(url).not.toContain('client_version')
  })
})

describe('responses-lite header (metadata driven)', () => {
  it('TEST 14: useResponsesLite=true adds the responses-lite header', () => {
    const headers = buildResponsesHeaders('tok', 'acct', true)
    expect(headers['x-openai-internal-codex-responses-lite']).toBe('true')
  })

  it('TEST 15: useResponsesLite=false omits the header', () => {
    const headers = buildResponsesHeaders('tok', 'acct', false)
    expect(headers['x-openai-internal-codex-responses-lite']).toBeUndefined()
  })

  it('TEST 16: useResponsesLite=undefined omits the header', () => {
    const headers = buildResponsesHeaders('tok', 'acct', undefined)
    expect(headers['x-openai-internal-codex-responses-lite']).toBeUndefined()
  })

  it('never fakes Codex CLI identity (no originator/User-Agent/version)', () => {
    const headers = buildResponsesHeaders('tok', 'acct', true)
    expect(headers['originator']).toBeUndefined()
    expect(headers['User-Agent']).toBeUndefined()
    expect(headers['version']).toBeUndefined()
  })

  it('TEST 13: /responses headers never include client_version', () => {
    const headers = buildResponsesHeaders('tok', 'acct', true)
    for (const key of Object.keys(headers)) {
      expect(key.toLowerCase()).not.toContain('client_version')
    }
    expect(JSON.stringify(headers)).not.toContain('client_version')
  })

  it('adds account id only when present', () => {
    expect(buildResponsesHeaders('tok', 'acct', false)['ChatGPT-Account-Id']).toBe('acct')
    expect(buildResponsesHeaders('tok', null, false)['ChatGPT-Account-Id']).toBeUndefined()
  })
})

describe('listModels 真实流程 — discovery 只请求一次，绝不 fallback 旧 release', () => {
  const stubCreds = {
    getAccessToken: async () => 'tok',
    getAccountId: async () => 'acct',
  } as unknown as OAuthCredentialManager

  const run = async (responses: Array<{ status: number; body: string }>) => {
    netStub.responses = responses
    netStub.requestedVersions = []
    netStub.callIndex = 0
    const client = new RealChatGPTCodexClient(stubCreds)
    let error: unknown = null
    let models: unknown = null
    try {
      models = await client.listModels()
    } catch (err) {
      error = err
    }
    return { error, models, requestedVersions: netStub.requestedVersions }
  }

  it('TEST 2: 400 → 只请求 sentinel 一次，绝不尝试 0.154 / 0.155 / 其他 release', async () => {
    const { error, requestedVersions } = await run([{ status: 400, body: '{"error":"client_version is too old"}' }])
    expect(requestedVersions).toEqual([CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL])
    expect(requestedVersions).not.toContain('0.154.0')
    expect(requestedVersions).not.toContain('0.155.0')
    expect(error).toBeInstanceOf(Error)
  })

  it('TEST 3: 500 → 只请求 sentinel 一次，正常抛错', async () => {
    const { error, requestedVersions } = await run([{ status: 500, body: 'server error' }])
    expect(requestedVersions).toEqual([CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL])
    expect(error).toBeInstanceOf(Error)
  })

  it('TEST 4: 401 / 403 → 只请求 sentinel 一次', async () => {
    const unauthorized = await run([{ status: 401, body: '{}' }])
    expect(unauthorized.requestedVersions).toEqual([CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL])
    expect(unauthorized.error).toBeInstanceOf(Error)

    const forbidden = await run([{ status: 403, body: '{}' }])
    expect(forbidden.requestedVersions).toEqual([CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL])
    expect(forbidden.error).toBeInstanceOf(Error)
  })

  it('TEST 5: HTTP 200 + models=[] → 返回空 catalog，不 fallback', async () => {
    const { error, models, requestedVersions } = await run([{ status: 200, body: '{"models":[]}' }])
    expect(error).toBeNull()
    expect(models).toEqual([])
    expect(requestedVersions).toEqual([CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL])
  })

  it('HTTP 200 + 有效 catalog → 只请求 sentinel 一次并解析', async () => {
    const { error, models, requestedVersions } = await run([
      { status: 200, body: '{"models":[{"slug":"gpt-6-astra","visibility":"list"}]}' },
    ])
    expect(error).toBeNull()
    expect((models as Array<{ slug: string }>)[0].slug).toBe('gpt-6-astra')
    expect(requestedVersions).toEqual([CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL])
  })
})

describe('SSE unknown event tolerance', () => {
  it('known types are recognized; unknown types are not', () => {
    expect(isKnownSSEEventType('response.output_text.delta')).toBe(true)
    expect(isKnownSSEEventType('response.completed')).toBe(true)
    expect(isKnownSSEEventType('error')).toBe(true)
    expect(isKnownSSEEventType('unknown.future.event')).toBe(false)
  })

  it('TEST: stream of known → unknown → known completes and yields knowns', () => {
    const parser = new ResponsesStreamParser()
    const events = parser.parse(
      'data: {"type":"response.output_text.delta","delta":"A"}\n\n' +
      'data: {"type":"unknown.future.event","foo":1}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"B"}\n\n' +
      'data: {"type":"response.completed","response":{"id":"1"}}\n\n'
    )
    const yielded = events
      .map((e) => JSON.parse(e.data))
      .filter((p) => p.type && isKnownSSEEventType(p.type))
    expect(yielded.map((p) => p.type)).toEqual([
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
    ])
    // 未知 event 不会中断后续已知 event
    expect(yielded[1].delta).toBe('B')
  })
})

describe('buildResponsesBody — Lite 固定字段', () => {
  it('TEST 6: Lite → parallel_tool_calls=false', () => {
    const body = buildResponsesBody({
      model: 'gpt-6-astra',
      instructions: '',
      input: [{ role: 'user', content: 'hello' }],
      useResponsesLite: true,
      reasoning: { effort: 'medium', summary: 'auto', context: 'all_turns' },
    })
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tools).toBeUndefined()
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto', context: 'all_turns' })
  })

  it('TEST 13: 最小 Lite 纯文本 → body 无 tools 键', () => {
    const body = buildResponsesBody({
      model: 'gpt-6-astra',
      instructions: '',
      input: [{ role: 'user', content: 'hello' }],
      useResponsesLite: true,
    })
    expect('tools' in body).toBe(false)
    expect('include' in body).toBe(false)
    expect(body.parallel_tool_calls).toBe(false)
  })

  it('non-Lite：无 parallel_tool_calls；tools 原样', () => {
    const body = buildResponsesBody({
      model: 'gpt-6-astra',
      instructions: '',
      input: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'web_search' }],
    })
    expect('parallel_tool_calls' in body).toBe(false)
    expect(body.tools).toEqual([{ type: 'web_search' }])
  })
})

describe('Non-Lite transport 输出（Transport Policy 判定 effectiveResponsesLite=false）', () => {
  // non-Lite request：codex-hosted 由 Transport Policy 决定为 Non-Lite，hosted web_search 位于顶层 tools。
  const nonLiteBody = {
    model: 'gpt-5.6-luna',
    instructions: '',
    input: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'web_search', search_context_size: 'high' }],
    include: ['web_search_call.action.sources'],
    toolChoice: 'auto' as const,
    reasoning: { effort: 'medium', summary: 'auto' },
  }

  it('TEST 6: effectiveResponsesLite=false → 无 Lite header', () => {
    const headers = buildResponsesHeaders('tok', 'acct', false)
    expect(headers['x-openai-internal-codex-responses-lite']).toBeUndefined()
  })

  it('TEST 7: effectiveResponsesLite=false → reasoning 无 context', () => {
    const body = buildResponsesBody(nonLiteBody)
    expect((body.reasoning as { context?: string }).context).toBeUndefined()
  })

  it('TEST 8: effectiveResponsesLite=false + hosted search → web_search 在顶层 tools（+include）', () => {
    const body = buildResponsesBody(nonLiteBody)
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
    expect(body.include).toEqual(['web_search_call.action.sources'])
    expect('parallel_tool_calls' in body).toBe(false)
  })
})

describe('summarizeResponsesShape (脱敏诊断摘要)', () => {
  it('TEST 3/13: 纯文本 Lite 请求 shape 无 top-level tools', () => {
    const shape = summarizeResponsesShape({
      model: 'gpt-6-astra',
      instructions: '',
      input: [{ role: 'user', content: 'hello' }],
      useResponsesLite: true,
      reasoning: { effort: 'medium', summary: 'auto', context: 'all_turns' },
    })
    expect(shape.hasTopLevelTools).toBe(false)
    expect(shape.topLevelToolCount).toBe(0)
    expect(shape.parallelToolCalls).toBe(false)
    expect(shape.reasoningContext).toBe('all_turns')
    expect(shape.inputTypes).toEqual(['user'])
    expect(shape.additionalTools).toEqual([])
  })

  it('暴露 top-level 与 additional_tools 的 type/name，但不含敏感字段', () => {
    const shape = summarizeResponsesShape({
      model: 'gpt-6-astra',
      instructions: 'SECRET_PROMPT',
      input: [
        { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'openchat_web_search' }] },
        { role: 'user', content: 'hello' },
      ],
      useResponsesLite: true,
      tools: [{ type: 'web_search', search_context_size: 'high' }],
    })
    expect(shape.topLevelTools).toEqual([{ type: 'web_search', name: undefined }])
    expect(shape.additionalTools).toEqual([{ type: 'function', name: 'openchat_web_search' }])
    // 绝不泄漏 prompt
    expect(JSON.stringify(shape)).not.toContain('SECRET_PROMPT')
  })

  // TEST 10：图片 shape 摘要只暴露 content type / MIME，绝不包含 base64
  it('TEST 10: 图片请求 shape 暴露 inputContentTypes / imageMimeTypes，绝不含 base64', () => {
    const SECRET_B64 = 'iVBORw0KGgoAAAANSECRETSECRET'
    const shape = summarizeResponsesShape({
      model: 'gpt-6-astra',
      instructions: '',
      input: [
        { role: 'user', content: [
          { type: 'input_text', text: 'SECRET_PROMPT' },
          { type: 'input_image', image_url: `data:image/png;base64,${SECRET_B64}` },
        ] },
      ],
      useResponsesLite: true,
    })
    expect(shape.inputContentTypes).toEqual([['input_text', 'input_image']])
    expect(shape.imageInputCount).toBe(1)
    expect(shape.imageMimeTypes).toEqual(['image/png'])
    const serialized = JSON.stringify(shape)
    expect(serialized).not.toContain(SECRET_B64)
    expect(serialized).not.toContain('base64')
    expect(serialized).not.toContain('SECRET_PROMPT')
    expect(serialized).not.toContain('data:image')
  })

  it('纯文本请求 shape：inputContentTypes 为空、imageInputCount=0', () => {
    const shape = summarizeResponsesShape({
      model: 'gpt-6-astra',
      instructions: '',
      input: [{ role: 'user', content: 'hello' }],
    })
    expect(shape.inputContentTypes).toEqual([])
    expect(shape.imageInputCount).toBe(0)
    expect(shape.imageMimeTypes).toEqual([])
  })
})
