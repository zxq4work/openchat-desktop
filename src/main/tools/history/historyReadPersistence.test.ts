import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { StorageService } from '../../storage/StorageService'
import { ConversationRepository } from '../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../storage/MessageRepository'
import type { Conversation, ContextSegment, Message } from '../../../shared/types/conversation'
import { ReadHistoryTool } from './ReadHistoryTool'

// 真实持久化回归：只读历史工具读取的是「真正写库再读回」的完整 tool output，
// 不是内存 fixture。覆盖 12640 字符长结果分段读全，以及 13 条来源可列举。
describe('ReadHistoryTool — 真实 MessageRepository 往返', () => {
  let directory: string
  let storage: StorageService

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(os.tmpdir(), 'openchat-read-history-'))
    storage = new StorageService(join(directory, 'openchat.db'))
    await storage.init()
  })

  afterEach(() => {
    storage.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function seed(): MessageRepository {
    const conversationId = 'c-hist'
    const segmentId = 'seg-hist'
    const conversation: Conversation = {
      id: conversationId, type: 'chat', title: '历史读取', systemPrompt: '', systemPromptRevision: 0,
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
      id: 'assistant-hist', conversationId, segmentId, role: 'assistant', content: '结果',
      attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
      webSearchResults: null, webSearchError: null, status: 'completed',
      modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
      providerPayloadJson: null, errorCode: null, errorMessage: null, createdAt: 5, updatedAt: 5,
    }
    const repo = new MessageRepository(storage)
    repo.create(message)
    return repo
  }

  it('12640 字符 output 写库读回后可完整分段读全（拼接等于原文）', async () => {
    const repo = seed()
    const longOutput = Array.from({ length: 12640 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    repo.updateProviderPayload('assistant-hist', {
      provider: 'chatgpt_codex',
      protocol: 'chatgpt_codex',
      items: [
        { type: 'function_call', call_id: 'run-1', name: 'run', namespace: 'web', arguments: '{}' },
        { type: 'function_call_output', call_id: 'run-1', output: longOutput },
      ],
    })

    const hydrated = repo.getByConversationId('c-hist')
    const tool = new ReadHistoryTool(hydrated)

    const listed = JSON.parse((await tool.execute({ action: 'list' }, {})).output)
    expect(listed.calls[0]).toMatchObject({ callId: 'run-1', outputLength: 12640 })

    let offset = 0
    let acc = ''
    for (let i = 0; i < 5; i++) {
      const page = JSON.parse((await tool.execute({ action: 'read', callId: 'run-1', offset, limit: 4096 }, {})).output)
      acc += page.content
      if (!page.hasMore) {
        expect(page.nextOffset).toBeNull()
        break
      }
      offset = page.nextOffset
    }
    expect(acc).toBe(longOutput)
  })

  it('混合查询：聚合来源 12 web + 1 api，单次网页搜索 callId 不冒充这 13 条', async () => {
    const repo = seed()
    // 复现真实混合场景：第一次 run=天气(results=0，仅内置 api 源)，第二次 run=网页 12 条。
    // 整条助手消息聚合 = 12 web + 1 api = 13 条。
    const sources = [
      ...Array.from({ length: 12 }, (_, i) => ({
        title: `网页 ${i}`, url: `https://web${i}.example`, snippet: `S${i}`, sourceType: 'web' as const,
      })),
      { title: '内置服务: oai-weather', url: null, snippet: null, sourceType: 'api' as const },
    ]
    repo.updateWebSearchResults('assistant-hist', sources)
    repo.updateProviderPayload('assistant-hist', {
      provider: 'chatgpt_codex',
      protocol: 'chatgpt_codex',
      items: [
        { type: 'function_call', call_id: 'run-weather', name: 'run', namespace: 'web', arguments: '{"weather":[{"location":"北京"}]}' },
        { type: 'function_call_output', call_id: 'run-weather', output: 'weather text' },
        { type: 'function_call', call_id: 'run-web', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"x"}]}' },
        { type: 'function_call_output', call_id: 'run-web', output: 'web text' },
      ],
    })

    const hydrated = repo.getByConversationId('c-hist')
    const tool = new ReadHistoryTool(hydrated)

    // 读取「第二次网页搜索」的 callId：绝不返回 13 条冒充为该次自身来源。
    const page = JSON.parse((await tool.execute({ action: 'read', callId: 'run-web' }, {})).output)
    expect(page.callSources).toBeNull()
    expect(page.messageSources).toHaveLength(13)
    expect(page.messageSources.filter((s: { sourceType?: string }) => s.sourceType === 'web')).toHaveLength(12)
    expect(page.messageSources.filter((s: { sourceType?: string }) => s.sourceType === 'api')).toHaveLength(1)

    // list 中两条 run 均标注 callSourceCount=null，messageSourceCount=13。
    const listed = JSON.parse((await tool.execute({ action: 'list' }, {})).output)
    expect(listed.calls.map((c: { callId: string }) => c.callId)).toEqual(['run-weather', 'run-web'])
    for (const c of listed.calls) {
      expect(c.callSourceCount).toBeNull()
      expect(c.messageSourceCount).toBe(13)
    }
  })
})
