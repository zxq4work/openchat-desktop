import { describe, it, expect, vi, beforeEach } from 'vitest'

// 捕获 protocol 注册调用，不启动真实 Electron。
// vi.hoisted 保证 mock 工厂可安全引用（vi.mock 会被提升到 import 之前）。
const captured = vi.hoisted(() => ({
  fileHandler: null as null | ((request: { url: string }, callback: (r: unknown) => void) => void),
  privileged: null as null | { scheme: string; privileges: Record<string, boolean> },
  fileProtocolRegisterCount: 0,
}))

vi.mock('electron', () => ({
  protocol: {
    registerFileProtocol: (_scheme: string, handler: (request: { url: string }, callback: (r: unknown) => void) => void) => {
      captured.fileHandler = handler
      captured.fileProtocolRegisterCount++
      return true
    },
    registerSchemesAsPrivileged: (schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>) => {
      captured.privileged = schemes[0]
    },
  },
}))

import { registerAttachmentScheme } from './AttachmentScheme'
import { registerAttachmentProtocol } from './AttachmentProtocol'
import type { AttachmentService } from '../services/attachments/AttachmentService'

const VALID_ID = 'abcdef12-3456-7890-abcd-ef1234567890'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// 调用一次已注册的 file handler，收集 callback 响应（统一 flush 掉内部 async 链）。
async function invoke(url: string): Promise<unknown[]> {
  const responses: unknown[] = []
  captured.fileHandler!({ url }, (r) => responses.push(r))
  await flush()
  return responses
}

function fakeService(): AttachmentService {
  return {
    resolveThumbnail: (id: string) => ({ filePath: `/managed/thumb/${id}.png`, mimeType: 'image/png' }),
    resolveOriginal: (id: string) => ({ filePath: `/managed/orig/${id}.jpg`, mimeType: 'image/jpeg' }),
  } as unknown as AttachmentService
}

beforeEach(() => {
  vi.restoreAllMocks()
  captured.fileHandler = null
  captured.privileged = null
  captured.fileProtocolRegisterCount = 0
  // 失败路径会 console.error；注册成功会 console.log；静音以免污染测试输出。
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('registerAttachmentScheme (Phase 1)', () => {
  it('注册 openchat-attachment 为标准 + 安全 scheme', () => {
    registerAttachmentScheme()
    expect(captured.privileged?.scheme).toBe('openchat-attachment')
    expect(captured.privileged?.privileges).toMatchObject({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    })
  })
})

describe('registerAttachmentProtocol (Phase 2)', () => {
  it('安装 file handler，且 handler 可在 resolver 尚未 ready 时等待', async () => {
    let resolveService!: (s: AttachmentService | null) => void
    const pending = new Promise<AttachmentService | null>((r) => { resolveService = r })
    registerAttachmentProtocol(() => pending)
    expect(captured.fileProtocolRegisterCount).toBe(1)

    const responses: unknown[] = []
    captured.fileHandler!({ url: `openchat-attachment://thumbnail/${VALID_ID}` }, (r) => responses.push(r))
    await flush()
    // resolver 未 settle：handler 必须仍在等待，不能提前回调
    expect(responses).toHaveLength(0)

    resolveService(fakeService())
    await flush()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual({ path: `/managed/thumb/${VALID_ID}.png`, mimeType: 'image/png' })
  })

  it('thumbnail 与 original 分别解析到正确路径', async () => {
    registerAttachmentProtocol(async () => fakeService())
    expect(await invoke(`openchat-attachment://thumbnail/${VALID_ID}`))
      .toEqual([{ path: `/managed/thumb/${VALID_ID}.png`, mimeType: 'image/png' }])
    expect(await invoke(`openchat-attachment://original/${VALID_ID}`))
      .toEqual([{ path: `/managed/orig/${VALID_ID}.jpg`, mimeType: 'image/jpeg' }])
  })

  it('未知 kind 回安全错误且不调用 service', async () => {
    const resolveThumbnail = vi.fn()
    registerAttachmentProtocol(async () => ({ resolveThumbnail, resolveOriginal: vi.fn() } as unknown as AttachmentService))
    const out = await invoke(`openchat-attachment://bogus/${VALID_ID}`)
    expect(out).toEqual([{ error: -6 }])
    expect(resolveThumbnail).not.toHaveBeenCalled()
  })

  it('非法 id 直接拒绝，不调用 resolver', async () => {
    const resolver = vi.fn(async () => fakeService())
    registerAttachmentProtocol(resolver)
    const out = await invoke(`openchat-attachment://thumbnail/x`)
    expect(out).toEqual([{ error: -6 }])
    expect(resolver).not.toHaveBeenCalled()
  })

  it('service 不可用（resolver → null）回错误，不挂起', async () => {
    registerAttachmentProtocol(async () => null)
    expect(await invoke(`openchat-attachment://thumbnail/${VALID_ID}`)).toEqual([{ error: -6 }])
  })

  it('resolver reject 时回错误且 callback 只调用一次', async () => {
    registerAttachmentProtocol(async () => { throw new Error('init failed') })
    const out = await invoke(`openchat-attachment://thumbnail/${VALID_ID}`)
    expect(out).toEqual([{ error: -6 }])
  })

  it('resolve 内部抛异常时 callback 仍只调用一次', async () => {
    registerAttachmentProtocol(async () => ({
      resolveThumbnail: () => { throw new Error('boom') },
      resolveOriginal: vi.fn(),
    } as unknown as AttachmentService))
    const out = await invoke(`openchat-attachment://thumbnail/${VALID_ID}`)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ error: -6 })
  })
})
