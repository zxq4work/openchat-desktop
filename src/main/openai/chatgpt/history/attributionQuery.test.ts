import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { StorageService } from '../../../storage/StorageService'
import { ConversationRepository } from '../../../storage/ConversationRepository'
import { ContextSegmentRepository } from '../../../storage/ContextSegmentRepository'
import { MessageRepository } from '../../../storage/MessageRepository'
import type { Conversation, ContextSegment, Message } from '../../../../shared/types/conversation'

// 真实 DB 回归：Model Provenance 使用轻量归属查询 getAttributionBySegment。
// 验证：
//   - 只投影归属字段，不带正文/reasoning/payload/附件；
//   - **严格限定在当前上下文段**（Cmd+R 新段绝不返回旧段消息）；
//   - created_at 相同（同一毫秒）时以 rowid 稳定次级排序，顺序不漂移；
//   - unknown（model_id 为 null）如实保留。
describe('MessageRepository — 归属元数据轻量查询（按段隔离）', () => {
  let directory: string
  let storage: StorageService
  let conversations: ConversationRepository
  let segments: ContextSegmentRepository
  let messages: MessageRepository
  const CONV = 'c-attr'

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(os.tmpdir(), 'openchat-attr-'))
    storage = new StorageService(join(directory, 'openchat.db'))
    await storage.init()
    conversations = new ConversationRepository(storage)
    segments = new ContextSegmentRepository(storage)
    messages = new MessageRepository(storage)
    const now = Date.now()
    const conv: Conversation = {
      id: CONV, type: 'chat', title: 't', systemPrompt: '', systemPromptRevision: 0,
      defaultModelId: 'deepseek-v4-pro', defaultReasoningEffort: null, currentSegmentId: 'seg-1',
      useModelInstructions: false, webSearchEnabled: false, codexSearchMode: 'hosted', searchEngine: 'bing',
      providerConfigId: null, defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
      providerNameSnapshot: null, modelNameSnapshot: null, requestParameterValues: {}, createdAt: now, updatedAt: now,
    }
    conversations.create(conv)
    for (const id of ['seg-0', 'seg-1']) {
      const seg: ContextSegment = {
        id, conversationId: CONV, sequence: id === 'seg-0' ? 1 : 2, reason: 'conversation-created',
        providerThreadId: null, systemPromptRevision: 0, systemPromptSnapshot: '', createdAt: now,
      }
      segments.create(seg)
    }
  })

  afterEach(() => {
    storage.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function makeMsg(over: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
    const base: Message = {
      id: '', conversationId: CONV, segmentId: 'seg-1', role: 'user',
      content: 'SECRET_BODY_TEXT', attachments: [], reasoningMeta: null,
      reasoningText: 'REASONING_SECRET', reasoningDisplayMode: 'none',
      webSearchResults: null, webSearchError: null, status: 'completed',
      modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
      providerPayloadJson: '{"secret":"PAYLOAD_SECRET"}',
      errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
    }
    return { ...base, ...over }
  }

  it('严格按段隔离：只返回该段消息，且不返回正文/推理/payload/附件', () => {
    messages.create(makeMsg({ id: 'a0', role: 'assistant', segmentId: 'seg-0', modelId: 'deepseek-v4-pro', createdAt: 1 }))
    messages.create(makeMsg({ id: 'a1', role: 'assistant', segmentId: 'seg-1', modelId: 'claude-haiku-4-5-20251001', createdAt: 2 }))
    const metas = messages.getAttributionBySegment('seg-1')
    // 只含 seg-1，绝不含 seg-0
    expect(metas.map((m) => m.id)).toEqual(['a1'])
    expect(metas.map((m) => m.modelId)).toEqual(['claude-haiku-4-5-20251001'])
    // 投影只含归属字段：序列化后绝不含任何敏感正文
    const dump = JSON.stringify(metas)
    expect(dump).not.toContain('SECRET_BODY_TEXT')
    expect(dump).not.toContain('REASONING_SECRET')
    expect(dump).not.toContain('PAYLOAD_SECRET')
    expect(Object.keys(metas[0]).sort()).toEqual(['id', 'modelId', 'role', 'segmentId', 'status'])
  })

  it('created_at 相同（同一毫秒）时以 rowid 稳定排序，顺序与插入一致', () => {
    messages.create(makeMsg({ id: 'm1', role: 'user', createdAt: 100 }))
    messages.create(makeMsg({ id: 'm2', role: 'assistant', modelId: 'deepseek-v4-pro', createdAt: 100 }))
    messages.create(makeMsg({ id: 'm3', role: 'user', createdAt: 100 }))
    messages.create(makeMsg({ id: 'm4', role: 'assistant', modelId: 'claude-haiku-4-5-20251001', createdAt: 100 }))
    const first = messages.getAttributionBySegment('seg-1').map((m) => m.id)
    const second = messages.getAttributionBySegment('seg-1').map((m) => m.id)
    expect(first).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(second).toEqual(first) // 重复查询顺序一致（稳定）
  })

  it('seg-0 有消息而 seg-1 为空时，查询 seg-1 返回空（不泄漏旧段）', () => {
    messages.create(makeMsg({ id: 's0', role: 'assistant', segmentId: 'seg-0', modelId: 'deepseek-v4-pro', createdAt: 1 }))
    expect(messages.getAttributionBySegment('seg-1')).toEqual([])
    expect(messages.getAttributionBySegment('seg-0').map((m) => m.id)).toEqual(['s0'])
  })

  it('model_id 为 null 时如实保留 null（unknown）', () => {
    messages.create(makeMsg({ id: 'u1', role: 'assistant', modelId: null, createdAt: 1 }))
    const metas = messages.getAttributionBySegment('seg-1')
    expect(metas[0].modelId).toBeNull()
  })
})
