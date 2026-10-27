import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { StorageService } from '../../../storage/StorageService'
import { ConversationRepository } from '../../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../../storage/MessageRepository'
import type { Conversation, ContextSegment, Message } from '../../../../shared/types/conversation'
import { buildStandaloneWebSearchResults, dedupeWeatherServiceSources } from './standaloneSourceAdapter'

// 真实持久化回归：不是仅靠 JSON.stringify/parse 模拟。
describe('Standalone 内置来源的 MessageRepository 往返', () => {
  let directory: string
  let storage: StorageService

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(os.tmpdir(), 'openchat-standalone-sources-'))
    storage = new StorageService(join(directory, 'openchat.db'))
    await storage.init()
  })

  afterEach(() => {
    storage.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('天气与重复网页来源保存再读取后数量、顺序、sourceType 和 url:null 不变', () => {
    const conversationId = 'c-sources'
    const segmentId = 'seg-sources'
    const conversation: Conversation = {
      id: conversationId, type: 'chat', title: '天气测试', systemPrompt: '', systemPromptRevision: 0,
      defaultModelId: null, defaultReasoningEffort: null, currentSegmentId: segmentId,
      useModelInstructions: false, webSearchEnabled: true, codexSearchMode: 'standalone',
      searchEngine: 'bing', providerConfigId: null,
      defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
      providerNameSnapshot: null, modelNameSnapshot: null, requestParameterValues: {},
      createdAt: 1, updatedAt: 1,
    }
    new ConversationRepository(storage).create(conversation)
    const segment: ContextSegment = {
      id: segmentId, conversationId, sequence: 0, reason: 'conversation-created',
      providerThreadId: null, systemPromptRevision: 0, systemPromptSnapshot: '', createdAt: 1,
    }
    new ContextSegmentRepository(storage).create(segment)
    const message: Message = {
      id: 'assistant-sources', conversationId, segmentId, role: 'assistant', content: '结果',
      attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
      webSearchResults: null, webSearchError: null, status: 'completed',
      modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
      providerPayloadJson: null, errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
    }
    const repo = new MessageRepository(storage)
    repo.create(message)

    const weather1 = buildStandaloneWebSearchResults({ weather: [{ location: '北京' }] }, [], true)
    const weather2 = buildStandaloneWebSearchResults(
      { weather: [{ location: '上海' }] },
      [{ title: '网页 A', url: 'https://a.example' }, { title: '网页 A', url: 'https://a.example' }], true
    )
    const sources = dedupeWeatherServiceSources([...weather1, ...weather2])
    repo.updateWebSearchResults(message.id, sources)

    const hydrated = repo.getBySegmentId(segmentId).find((m) => m.id === message.id)
    expect(hydrated?.webSearchResults).toEqual(sources)
    expect(hydrated?.webSearchResults?.filter((r) => r.sourceType === 'api')).toHaveLength(1)
    expect(hydrated?.webSearchResults?.filter((r) => r.sourceType === 'web')).toHaveLength(2)
    expect(hydrated?.webSearchResults?.find((r) => r.sourceType === 'api')?.url).toBeNull()
  })
})
