import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

import { StorageService } from '../storage/StorageService'
import { ConversationRepository } from '../storage/ConversationRepository'
import { MessageRepository } from '../storage/MessageRepository'
import type { Conversation, Message } from '../../shared/types/conversation'
import type { ConversationSearchScope } from '../../shared/types/search'
import {
  escapeLike,
  buildSnippet,
  splitMatchedText,
  rankConversationSearchResults,
  aggregateConversationSearchResults,
  type ConversationSummaryRow,
} from '../../shared/search/conversationSearch'

// ===== 纯函数单元测试 =====

describe('conversationSearch — 纯函数', () => {
  it('escapeLike 转义 % _ \\', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('c\\d')).toBe('c\\\\d')
    expect(escapeLike("it's")).toBe("it's")
  })

  it('buildSnippet 命中词居中并加省略号，压缩空白', () => {
    const content = 'x'.repeat(200) + ' Greenplum ' + 'y'.repeat(200)
    const snippet = buildSnippet(content, 'Greenplum', 160)
    expect(snippet).toContain('Greenplum')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(163) // 160 + 两个省略号
    // 连续空白被折叠
    expect(buildSnippet('a   b\n\nc', 'b', 80)).toBe('a b c')
  })

  it('splitMatchedText 大小写不敏感拆分且保留原文大小写', () => {
    const parts = splitMatchedText('Greenplum and greenplum', 'greenplum')
    const matched = parts.filter((p) => p.matched).map((p) => p.text)
    expect(matched).toEqual(['Greenplum', 'greenplum'])
    expect(parts.map((p) => p.text).join('')).toBe('Greenplum and greenplum')
  })

  it('rankConversationSearchResults 标题完全等于 > 前缀 > 包含 > 正文命中', () => {
    const rows = [
      { conversationId: 'd', title: '无关标题', updatedAt: 999, titleMatched: false, contentMatchCount: 3, bestMatch: undefined },
      { conversationId: 'c', title: '优化SQL查询', updatedAt: 1, titleMatched: true, contentMatchCount: 0 },
      { conversationId: 'a', title: 'SQL', updatedAt: 1, titleMatched: true, contentMatchCount: 0 },
      { conversationId: 'b', title: 'SQL排序报错分析', updatedAt: 1, titleMatched: true, contentMatchCount: 0 },
    ]
    const ranked = rankConversationSearchResults(rows, 'SQL')
    expect(ranked.map((r) => r.conversationId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('aggregateConversationSearchResults 按会话聚合，正文命中只计 message 数', () => {
    const summaries: ConversationSummaryRow[] = [
      { id: 'c1', title: 'MQS质量分析', updatedAt: 10 },
      { id: 'c2', title: 'SQL', updatedAt: 20 },
    ]
    const hits = [
      { conversationId: 'c1', messageId: 'm1', role: 'user' as const, content: 'C1000=问题数/样本数×1000', createdAt: 1 },
      { conversationId: 'c1', messageId: 'm2', role: 'assistant' as const, content: 'C1000 出现 C1000 两次', createdAt: 2 },
      { conversationId: 'c1', messageId: 'm3', role: 'user' as const, content: '还有 C1000', createdAt: 3 },
      { conversationId: 'c1', messageId: 'm4', role: 'assistant' as const, content: 'C1000 again', createdAt: 4 },
      { conversationId: 'c1', messageId: 'm5', role: 'user' as const, content: 'C1000 last', createdAt: 5 },
    ]
    const results = aggregateConversationSearchResults({
      query: 'C1000',
      scope: 'all',
      candidateSummaries: summaries,
      contentHits: hits,
    })
    // 一个会话只出现一次，且 contentMatchCount=5（m2 内出现两次也只算 1 条）
    expect(results.length).toBe(1)
    expect(results[0].conversationId).toBe('c1')
    expect(results[0].contentMatchCount).toBe(5)
    expect(results[0].bestMatch?.messageId).toBe('m1')
  })
})

// ===== DB 集成测试（真实 sql.js 查询） =====

describe('conversationSearch — 数据库检索', () => {
  let dir: string
  let storage: StorageService
  let conversations: ConversationRepository
  let messages: MessageRepository

  beforeEach(async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-search-'))
    storage = new StorageService(join(dir, 'openchat.db'))
    await storage.init()
    conversations = new ConversationRepository(storage)
    messages = new MessageRepository(storage)
  })

  afterEach(() => {
    storage.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function makeConversation(id: string, title: string, updatedAt = Date.now()): Conversation {
    return {
      id, type: 'chat', title, systemPrompt: '', systemPromptRevision: 0,
      defaultModelId: null, defaultReasoningEffort: null, currentSegmentId: `${id}-seg`,
      useModelInstructions: true, webSearchEnabled: false, codexSearchMode: 'hosted',
      searchEngine: 'bing', providerConfigId: null,
      defaultImageSize: null, defaultImageQuality: null, defaultImageBackground: null,
      providerNameSnapshot: null, modelNameSnapshot: null,
      createdAt: updatedAt, updatedAt,
    }
  }

  let seq = 0
  function addMessage(conversationId: string, role: 'user' | 'assistant', content: string, overrides: Partial<Message> = {}): Message {
    const id = `m-${seq++}`
    const now = Date.now() + seq
    const msg: Message = {
      id, conversationId, segmentId: `${conversationId}-seg`, role, content,
      attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
      webSearchResults: null, webSearchError: null, status: 'completed',
      modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
      providerPayloadJson: null, errorCode: null, errorMessage: null,
      createdAt: now, updatedAt: now,
      ...overrides,
    }
    messages.create(msg)
    return msg
  }

  // 复刻 ChatGPTConversationService.searchConversations 的组合逻辑（仓库 + 纯聚合）
  function runSearch(query: string, scope: ConversationSearchScope) {
    const q = query.trim()
    if (!q) return []
    const wantContent = scope === 'all' || scope === 'content'
    const contentHits = wantContent ? messages.searchMessagesByContent(q) : []
    const lower = q.toLowerCase()
    const map = new Map<string, ConversationSummaryRow>()
    if (scope === 'all' || scope === 'title') {
      for (const s of conversations.listSummaries()) {
        if (s.title.toLowerCase().includes(lower)) map.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt })
      }
    }
    const missing = [...new Set(contentHits.map((h) => h.conversationId))].filter((id) => !map.has(id))
    if (missing.length > 0) {
      for (const s of conversations.getSummariesByIds(missing)) {
        map.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt })
      }
    }
    return aggregateConversationSearchResults({ query: q, scope, candidateSummaries: [...map.values()], contentHits })
  }

  it('CASE 1: 标题含 SQL、正文无 SQL → scope=title 能搜到', () => {
    conversations.create(makeConversation('c1', 'SQL排序报错分析'))
    addMessage('c1', 'user', '加了 ORDER BY 就报错')
    addMessage('c1', 'assistant', '这是临时文件问题')
    expect(runSearch('SQL', 'title').map((r) => r.conversationId)).toEqual(['c1'])
    expect(runSearch('SQL', 'content')).toEqual([])
  })

  it('CASE 2: 标题无 Greenplum、正文含 → scope=content 能搜到', () => {
    conversations.create(makeConversation('c2', '数据库恢复原因'))
    addMessage('c2', 'assistant', 'Greenplum database system is in recovery mode')
    expect(runSearch('Greenplum', 'content').map((r) => r.conversationId)).toEqual(['c2'])
  })

  it('CASE 3: scope=title 不匹配仅正文命中', () => {
    conversations.create(makeConversation('c3', '普通标题'))
    addMessage('c3', 'user', '这句话里有 Greenplum')
    expect(runSearch('Greenplum', 'title')).toEqual([])
  })

  it('CASE 4: scope=content 不匹配仅标题命中', () => {
    conversations.create(makeConversation('c4', 'Greenplum 分析'))
    addMessage('c4', 'user', '正文完全无关')
    expect(runSearch('Greenplum', 'content')).toEqual([])
  })

  it('CASE 5: scope=all 标题或正文任一匹配都算', () => {
    conversations.create(makeConversation('c5a', 'Greenplum 标题命中'))
    conversations.create(makeConversation('c5b', '正文命中'))
    addMessage('c5b', 'user', '正文含 Greenplum')
    const ids = runSearch('Greenplum', 'all').map((r) => r.conversationId).sort()
    expect(ids).toEqual(['c5a', 'c5b'])
  })

  it('CASE 6: 一个会话 5 条 message 命中 → 只出现一次，contentMatchCount=5', () => {
    conversations.create(makeConversation('c6', 'MQS质量分析'))
    for (let i = 0; i < 5; i++) addMessage('c6', i % 2 === 0 ? 'user' : 'assistant', `第${i}条含 C1000 指标`)
    const results = runSearch('C1000', 'content')
    expect(results.length).toBe(1)
    expect(results[0].contentMatchCount).toBe(5)
  })

  it('CASE 7: reasoning 中的关键字不参与匹配', () => {
    conversations.create(makeConversation('c7', '推理测试'))
    addMessage('c7', 'assistant', '可见正文没有关键词', { reasoningText: '这里思考了 Greenplum 的问题' })
    expect(runSearch('Greenplum', 'content')).toEqual([])
  })

  it('CASE 8: tool / provider payload 中的关键字不参与匹配', () => {
    conversations.create(makeConversation('c8', '工具结果测试'))
    addMessage('c8', 'user', '正文无关键词', {
      providerPayloadJson: JSON.stringify({ toolResult: 'Greenplum output' }),
      webSearchResults: [{ title: 'Greenplum', url: 'http://x', snippet: 'Greenplum' }],
    })
    expect(runSearch('Greenplum', 'content')).toEqual([])
  })

  it('CASE 9: 特殊字符 % _ \\ \' " 按普通文本处理，不报错', () => {
    conversations.create(makeConversation('c9', '特殊字符'))
    addMessage('c9', 'user', '进度是 100% 完成')
    addMessage('c9', 'user', '变量名 foo_bar')
    addMessage('c9', 'user', "含有反斜杠 C:\\path 与引号 it's \"q\"")
    addMessage('c9', 'user', '普通文本没有任何特殊符号')

    expect(runSearch('%', 'content').length).toBe(1)
    expect(runSearch('foo_bar', 'content').length).toBe(1)
    // _ 通配不应误匹配 foo_bar 之外的任意单字符
    expect(runSearch('_', 'content').length).toBe(1)
    expect(runSearch('C:\\path', 'content').length).toBe(1)
    expect(runSearch("it's", 'content').length).toBe(1)
  })

  it('CASE 10: 空 query 不查库，返回空结果', () => {
    conversations.create(makeConversation('c10', '任意标题'))
    addMessage('c10', 'user', '任意正文')
    expect(runSearch('', 'all')).toEqual([])
    expect(runSearch('   ', 'all')).toEqual([])
  })

  it('CASE 11: 英文大小写不敏感', () => {
    conversations.create(makeConversation('c11', 'CaseTest'))
    addMessage('c11', 'assistant', 'The Greenplum system works')
    expect(runSearch('greenplum', 'content').map((r) => r.conversationId)).toEqual(['c11'])
    expect(runSearch('GREENPLUM', 'content').map((r) => r.conversationId)).toEqual(['c11'])
  })

  it('CASE 12: 中文正常匹配', () => {
    conversations.create(makeConversation('c12', '故障分析'))
    addMessage('c12', 'assistant', '数据库恢复过程记录')
    expect(runSearch('数据库恢复', 'content').map((r) => r.conversationId)).toEqual(['c12'])
  })

  it('CASE 13: 两条内容完全相同的消息各计一次（contentMatchCount=2）', () => {
    conversations.create(makeConversation('c15', '重复内容'))
    const m1 = addMessage('c15', 'user', '这段内容完全相同')
    const m2 = addMessage('c15', 'user', '这段内容完全相同')
    const results = runSearch('这段内容完全相同', 'content')
    // 不能因为 role+content 相同就误判为重复
    expect(results.length).toBe(1)
    expect(results[0].contentMatchCount).toBe(2)

    // 单会话导航同样返回两条
    const matches = messages.searchMatchesInConversation('c15', '这段内容完全相同')
    expect(matches.map((m) => m.messageId)).toEqual([m1.id, m2.id])
  })

  it('searchMatchesInConversation 返回会话内全部匹配 message（导航用）', () => {
    conversations.create(makeConversation('c13', '多命中'))
    const m1 = addMessage('c13', 'user', 'Greenplum 第一条')
    const m2 = addMessage('c13', 'assistant', 'Greenplum 第二条')
    addMessage('c13', 'user', '无关')
    const matches = messages.searchMatchesInConversation('c13', 'Greenplum')
    expect(matches.map((m) => m.messageId)).toEqual([m1.id, m2.id])
  })

  it('搜索是只读的：不修改 conversation.updatedAt / message 内容', () => {
    conversations.create(makeConversation('c14', '只读测试', 123456))
    const msg = addMessage('c14', 'user', 'Greenplum 内容')
    const before = conversations.getById('c14')!.updatedAt
    runSearch('Greenplum', 'all')
    const after = conversations.getById('c14')!.updatedAt
    expect(after).toBe(before)
    expect(messages.getById(msg.id)!.content).toBe('Greenplum 内容')
  })
})
