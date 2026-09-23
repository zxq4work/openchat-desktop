import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Adapter 经 codexClient 间接依赖 httpsClient 的 electron net/session（仅在真实请求时使用）。
// 本测试只验证 buildRequest 的图片 wire-format 映射，不发起网络请求。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { ChatGPTCodexAdapter } from './ChatGPTCodexAdapter'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { resolveEffectiveResponsesLite } from '../openai/chatgpt/transport/responsesTransportPolicy'
import type { CanonicalModelRequest, CanonicalMessage } from '../../shared/types/provider'

const stubClient = {} as ChatGPTCodexClient
const adapter = new ChatGPTCodexAdapter(stubClient)

interface ContentItem { type: string; text?: string; image_url?: string; detail?: string }
interface InputItem { role?: string; type?: string; content?: string | ContentItem[]; tools?: unknown[] }
interface BuiltRequest {
  useResponsesLite?: boolean
  tools?: unknown[]
  include?: string[]
  input: InputItem[]
}
interface Buildable { buildRequest(request: CanonicalModelRequest): BuiltRequest }
const build = (req: CanonicalModelRequest) => (adapter as unknown as Buildable).buildRequest(req)

// 真实临时文件，让 readImageDataUrl 读到字节（PNG 幻数 / JPEG 幻数均可，Adapter 不嗅探类型）。
function writeTempImage(bytes: Buffer, ext: string): string {
  const p = join(tmpdir(), `openchat-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  fs.writeFileSync(p, bytes)
  return p
}
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

const userMsg = (parts: CanonicalMessage['inputParts']): CanonicalMessage => ({ role: 'user', content: '', inputParts: parts })

const resolverFor = (path: string, mimeType: string) => ({
  resolveForProvider: (id: string) => (id === 'att-1' ? { storagePath: path, mimeType, width: 4, height: 4 } : null),
})

const userContent = (b: BuiltRequest): ContentItem[] => {
  const m = b.input.find((i) => i.role === 'user')!
  return m.content as ContentItem[]
}

describe('ChatGPTCodexAdapter — image input wire format', () => {
  // TEST 1
  it('TEST 1: PNG attachment → user.content 含 input_image', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra',
      systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'att-1' }])],
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const parts = userContent(build(req))
    expect(parts.some((p) => p.type === 'input_image')).toBe(true)
    fs.unlinkSync(path)
  })

  // TEST 2
  it('TEST 2: PNG → image_url startsWith data:image/png;base64,', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'image', attachmentId: 'att-1' }])],
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const img = userContent(build(req)).find((p) => p.type === 'input_image')!
    expect(img.image_url!.startsWith('data:image/png;base64,')).toBe(true)
    fs.unlinkSync(path)
  })

  // TEST 3
  it('TEST 3: JPEG → image_url startsWith data:image/jpeg;base64,', () => {
    const path = writeTempImage(JPEG_BYTES, 'jpg')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'image', attachmentId: 'att-1' }])],
      attachmentResolver: resolverFor(path, 'image/jpeg'),
    }
    const img = userContent(build(req)).find((p) => p.type === 'input_image')!
    expect(img.image_url!.startsWith('data:image/jpeg;base64,')).toBe(true)
    fs.unlinkSync(path)
  })

  // TEST 4
  it('TEST 4: attachment + text → 同一 user content 同时存在 input_text 与 input_image', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'att-1' }])],
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const parts = userContent(build(req))
    expect(parts[0].type).toBe('input_text')
    expect(parts[1].type).toBe('input_image')
    expect(parts.some((p) => p.type === 'input_text')).toBe(true)
    expect(parts.some((p) => p.type === 'input_image')).toBe(true)
    fs.unlinkSync(path)
  })

  // TEST 5
  it('TEST 5: 图片上传不产生 image_generation tool', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'att-1' }])],
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const b = build(req)
    const topLevel = (b.tools ?? []) as Array<{ type?: string }>
    expect(topLevel.some((t) => t.type === 'image_generation')).toBe(false)
    const additional = b.input
      .filter((i) => i.type === 'additional_tools')
      .flatMap((i) => (i.tools ?? []) as Array<{ type?: string; name?: string }>)
    expect(additional.some((t) => t.type === 'image_generation' || t.name === 'image_generation')).toBe(false)
    // 确认 wire 上没有任何 image_generation 字符串
    expect(JSON.stringify(b)).not.toContain('image_generation')
    fs.unlinkSync(path)
  })

  // TEST 6
  it('TEST 6: Lite + image + Search OFF → effectiveResponsesLite=true，图片仍为 input_image', () => {
    const effective = resolveEffectiveResponsesLite({ modelWantsResponsesLite: true, searchStrategy: 'none' })
    expect(effective).toBe(true)

    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'att-1' }])],
      responsesLite: effective,
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const b = build(req)
    expect(b.useResponsesLite).toBe(true)
    expect(userContent(b).some((p) => p.type === 'input_image')).toBe(true)
    fs.unlinkSync(path)
  })

  // TEST 7
  it('TEST 7: Lite + image + codex-hosted → effectiveResponsesLite=false，hosted web_search 正常保留', () => {
    const effective = resolveEffectiveResponsesLite({ modelWantsResponsesLite: true, searchStrategy: 'codex-hosted' })
    expect(effective).toBe(false)

    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'att-1' }])],
      responsesLite: effective,
      tools: [{ name: 'web_search', description: '', parameters: {}, toolType: 'web_search' }],
      toolChoice: 'auto',
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const b = build(req)
    expect(b.useResponsesLite).toBeUndefined()
    expect(b.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
    expect(b.include).toEqual(['web_search_call.action.sources'])
    expect(userContent(b).some((p) => p.type === 'input_image')).toBe(true)
    fs.unlinkSync(path)
  })

  // TEST 8
  it('TEST 8: 历史图片消息重建 → 仍按既有设计逐轮重建 input_image（不改 history policy）', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const historyUser = userMsg([{ type: 'text', text: '旧图' }, { type: 'image', attachmentId: 'att-1' }])
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [historyUser, { role: 'assistant', content: '看到图了' }, { role: 'user', content: '再问' }],
      attachmentResolver: resolverFor(path, 'image/png'),
    }
    const b = build(req)
    const imgs: Array<InputItem> = b.input.filter((i) => Array.isArray(i.content) && (i.content as ContentItem[]).some((c) => c.type === 'input_image'))
    expect(imgs).toHaveLength(1)
    fs.unlinkSync(path)
  })

  // TEST 9
  it('TEST 9: 附件读取失败 → 抛既有错误，不打印路径/base64，不 crash', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'att-1' }])],
      attachmentResolver: { resolveForProvider: () => ({ storagePath: '/nonexistent/secret/path.png', mimeType: 'image/png', width: 1, height: 1 }) },
    }
    expect(() => build(req)).toThrow(/图片文件读取失败/)
    // 所有 error 输出不得包含本地路径
    for (const call of consoleSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('/nonexistent/secret/path.png')
    }
    consoleSpy.mockRestore()
  })

  it('图片附件无法解析（resolver 返回 null）→ 抛既有错误，不静默降级为纯文本', () => {
    const req: CanonicalModelRequest = {
      model: 'gpt-6-astra', systemPrompt: '',
      messages: [userMsg([{ type: 'text', text: '看图' }, { type: 'image', attachmentId: 'missing' }])],
      attachmentResolver: { resolveForProvider: () => null },
    }
    expect(() => build(req)).toThrow(/图片附件无法解析/)
  })
})
