import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import type { MessageAttachment } from '../../../shared/types/conversation'

// AttachmentService 顶层 import electron 的 nativeImage（仅在 prepareFromBytes 用到）。
// cleanupOrphans 不触碰 nativeImage，但 import 会执行，故用最小 mock 占位。
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }))

import { AttachmentService } from './AttachmentService'
import type { AttachmentRepository } from '../../storage/AttachmentRepository'

const DAY = 24 * 60 * 60 * 1000

function att(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    id: 'a',
    messageId: null,
    conversationId: 'c1',
    segmentId: null,
    type: 'image',
    mimeType: 'image/png',
    fileName: 'x.png',
    fileSize: 100,
    width: 10,
    height: 10,
    detail: 'auto',
    sha256: 'deadbeef',
    source: 'user_upload',
    usage: 'chat_input',
    createdAt: Date.now(),
    ...overrides,
  }
}

// 内存版 repo：只实现 cleanupOrphans 依赖的方法
class FakeRepo {
  rows: MessageAttachment[] = []
  existingMessages = new Set<string>()

  listAll(): MessageAttachment[] { return this.rows }
  existingMessageIds(ids: string[]): Set<string> {
    const out = new Set<string>()
    for (const id of ids) if (this.existingMessages.has(id)) out.add(id)
    return out
  }
  remove(id: string): void { this.rows = this.rows.filter((r) => r.id !== id) }
}

describe('AttachmentService.cleanupOrphans', () => {
  let dir: string
  let repo: FakeRepo
  let service: AttachmentService
  const liveConvs = new Set(['c1'])

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-cleanup-'))
    repo = new FakeRepo()
    service = new AttachmentService(dir, repo as unknown as AttachmentRepository)
  })

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('1. unbound draft younger than 24h is kept', () => {
    repo.rows = [att({ id: 'draft-new', messageId: null, conversationId: 'c1', createdAt: Date.now() - 1000 })]
    service.cleanupOrphans(liveConvs)
    expect(repo.rows.map((r) => r.id)).toEqual(['draft-new'])
  })

  it('2. unbound draft older than 24h is removed', () => {
    repo.rows = [att({ id: 'draft-old', messageId: null, conversationId: 'c1', createdAt: Date.now() - 2 * DAY })]
    service.cleanupOrphans(liveConvs)
    expect(repo.rows).toEqual([])
  })

  it('3. attachment bound to a live message older than 24h is kept', () => {
    repo.existingMessages = new Set(['m1'])
    repo.rows = [att({ id: 'bound', messageId: 'm1', conversationId: 'c1', createdAt: Date.now() - 10 * DAY })]
    service.cleanupOrphans(liveConvs)
    expect(repo.rows.map((r) => r.id)).toEqual(['bound'])
  })

  it('3b. bound to a message whose conversation no longer exists is removed after TTL', () => {
    repo.existingMessages = new Set(['m1']) // message 行残留（级联未生效）
    repo.rows = [att({ id: 'orphan-bound', messageId: 'm1', conversationId: 'gone', createdAt: Date.now() - 10 * DAY })]
    service.cleanupOrphans(liveConvs)
    expect(repo.rows).toEqual([])
  })

  it('4. conversation deleted + older than 24h is removed', () => {
    repo.rows = [att({ id: 'gone-old', messageId: null, conversationId: 'deleted', createdAt: Date.now() - 2 * DAY })]
    service.cleanupOrphans(liveConvs)
    expect(repo.rows).toEqual([])
  })

  it('4b. conversation deleted but younger than 24h is kept (init race guard)', () => {
    repo.rows = [att({ id: 'gone-new', messageId: null, conversationId: 'deleted', createdAt: Date.now() - 1000 })]
    service.cleanupOrphans(liveConvs)
    expect(repo.rows.map((r) => r.id)).toEqual(['gone-new'])
  })

  it('5. repeated cleanup is idempotent', () => {
    repo.existingMessages = new Set(['m1'])
    repo.rows = [
      att({ id: 'keep-bound', messageId: 'm1', conversationId: 'c1', createdAt: Date.now() - 10 * DAY }),
      att({ id: 'keep-new-draft', messageId: null, conversationId: 'c1', createdAt: Date.now() - 1000 }),
      att({ id: 'drop-old-draft', messageId: null, conversationId: 'c1', createdAt: Date.now() - 2 * DAY }),
      att({ id: 'drop-dead-conv', messageId: null, conversationId: 'deleted', createdAt: Date.now() - 2 * DAY }),
    ]
    service.cleanupOrphans(liveConvs)
    const afterFirst = repo.rows.map((r) => r.id).sort()
    service.cleanupOrphans(liveConvs)
    const afterSecond = repo.rows.map((r) => r.id).sort()

    expect(afterFirst).toEqual(['keep-bound', 'keep-new-draft'])
    expect(afterSecond).toEqual(afterFirst)
  })

  it('removes DB row even when managed files are missing', () => {
    // 文件从未落盘；deleteFiles 必须容忍并仍然删行
    repo.rows = [att({ id: 'no-file', messageId: null, conversationId: 'c1', createdAt: Date.now() - 2 * DAY })]
    expect(() => service.cleanupOrphans(liveConvs)).not.toThrow()
    expect(repo.rows).toEqual([])
  })
})
