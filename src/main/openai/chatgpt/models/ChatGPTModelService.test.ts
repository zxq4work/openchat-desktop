import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatGPTModelService, isModelVisible } from './ChatGPTModelService'
import { CHATGPT_MODEL_CATALOG_CLIENT_VERSION } from './modelCatalogVersion'
import type { ChatGPTCodexClient, ChatGPTModel } from '../transport/ChatGPTCodexClient'
import { MODELS_CATALOG_FIXTURE } from './fixtures/modelsCatalog.fixture'

// 可注入的假 client：listModels 返回给定 catalog（或抛错）。
class FakeClient implements ChatGPTCodexClient {
  constructor(
    private models: ChatGPTModel[],
    private error?: Error
  ) {}
  async listModels(): Promise<ChatGPTModel[]> {
    if (this.error) throw this.error
    return this.models
  }
  sendResponses(): AsyncIterable<never> {
    const empty = (async function* () {})()
    return empty as AsyncIterable<never>
  }
}

const fixtureModels = MODELS_CATALOG_FIXTURE.models as unknown as ChatGPTModel[]

describe('ChatGPTModelService normalization (fixture)', () => {
  let service: ChatGPTModelService

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TEST 5: future unknown model slug auto-enters model list', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    const models = await service.fetchModels()
    const future = models.find((m) => m.id === 'gpt-x-future-model')
    expect(future).toBeDefined()
    expect(future?.displayName).toBe('GPT X Future')
    expect(future?.hidden).toBe(false)
  })

  it('TEST 6: future unknown metadata does not break parsing', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    const models = await service.fetchModels()
    // 整个列表都解析成功，future model 仍在
    expect(models.map((m) => m.id)).toEqual([
      'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-x-future-model',
    ])
  })

  it('TEST 7: reasoning effort "ultra" is preserved', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    const models = await service.fetchModels()
    const astra = models.find((m) => m.id === 'gpt-6-astra')
    expect(astra?.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toContain('ultra')
  })

  it('TEST 8: unknown reasoning effort "future-level" is preserved', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    const models = await service.fetchModels()
    const future = models.find((m) => m.id === 'gpt-x-future-model')
    expect(future?.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(['future-level'])
    expect(future?.defaultReasoningEffort).toBe('future-level')
  })

  it('captures responsesLite + context + toolMode metadata', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    const models = await service.fetchModels()
    const astra = models.find((m) => m.id === 'gpt-6-astra')
    expect(astra?.useResponsesLite).toBe(true)
    expect(astra?.contextWindow).toBe(272000)
    expect(astra?.maxContextWindow).toBe(872000)
    expect(astra?.toolMode).toBe('code_mode_only')
    expect(astra?.supportsSearchTool).toBe(true)
  })

  it('TEST 15: raw effort 与长 description 均被原样保留（service 层不做 presentation）', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    const models = await service.fetchModels()
    const astra = models.find((m) => m.id === 'gpt-6-astra')
    const medium = astra?.supportedReasoningEfforts.find((e) => e.reasoningEffort === 'medium')
    expect(medium?.reasoningEffort).toBe('medium')
    // description 是长解释文本，不是名称；service 绝不做 medium → Medium 这类 presentation
    expect(medium?.description).toBe('Balances speed and reasoning depth for everyday tasks')
  })

  it('getModelInfo returns metadata by id; undefined for unknown', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    await service.fetchModels()
    expect(service.getModelInfo('gpt-6-sol')?.useResponsesLite).toBe(true)
    expect(service.getModelInfo('does-not-exist')).toBeUndefined()
  })

  it('TEST 17: resolveEffort never returns an unsupported previous effort', async () => {
    service = new ChatGPTModelService(new FakeClient(fixtureModels))
    await service.fetchModels()
    const luna = service.getModelInfo('gpt-6-luna')!
    // 旧模型设置过 ultra，但 luna 不支持 ultra → 回退到 default(medium)
    expect(service.resolveEffort(luna, 'ultra')).toBe('medium')
  })

  it('TEST 19: refresh network failure keeps previously loaded models', async () => {
    const svc = new ChatGPTModelService(new FakeClient(fixtureModels))
    await svc.fetchModels()
    const cached = svc.currentModels
    expect(cached.length).toBeGreaterThan(0)

    // 模拟刷新失败：替换私有 client 使其抛错
    ;(svc as unknown as { client: ChatGPTCodexClient }).client = new FakeClient([], new Error('network down'))
    const after = await svc.fetchModels()

    // 旧模型列表必须原样保留，绝不 setModels([])
    expect(after).toBe(cached)
    expect(after.length).toBe(cached.length)
    expect(svc.state.error).toBe('network down')
  })
})

describe('isModelVisible', () => {
  it('TEST 9: visibility=list → visible', () => {
    expect(isModelVisible({ slug: 'a', visibility: 'list' })).toBe(true)
  })
  it('TEST 10: visibility=hide → hidden', () => {
    expect(isModelVisible({ slug: 'a', visibility: 'hide' })).toBe(false)
  })
  it('TEST 11: visibility=none → hidden', () => {
    expect(isModelVisible({ slug: 'a', visibility: 'none' })).toBe(false)
  })
  it('TEST 12: supported_in_api=false → hidden', () => {
    expect(isModelVisible({ slug: 'a', visibility: 'list', supported_in_api: false })).toBe(false)
  })
  it('TEST 13: missing visibility → visible (backward compatible)', () => {
    expect(isModelVisible({ slug: 'a' })).toBe(true)
  })
  it('missing supported_in_api is NOT treated as false', () => {
    expect(isModelVisible({ slug: 'a', visibility: 'list' })).toBe(true)
  })
  it('unknown visibility string → visible + warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isModelVisible({ slug: 'a', visibility: 'future-visibility' })).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('minimal_client_version safety net', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('TEST 20: model requiring newer client than catalog version is hidden', async () => {
    const futureVersion = '999.0.0'
    const svc = new ChatGPTModelService(new FakeClient([
      { slug: 'too-new', display_name: 'Too New', visibility: 'list', supported_in_api: true, minimal_client_version: futureVersion },
      { slug: 'ok', display_name: 'OK', visibility: 'list', supported_in_api: true, minimal_client_version: '0.100.0' },
    ]))
    const models = await svc.fetchModels()
    expect(models.find((m) => m.id === 'too-new')?.hidden).toBe(true)
    expect(models.find((m) => m.id === 'ok')?.hidden).toBe(false)
  })

  it('catalog version is 0.155.0 by default (env override respected)', () => {
    expect(CHATGPT_MODEL_CATALOG_CLIENT_VERSION).toBe('0.155.0')
  })
})
