import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Adapter 经 httpsClient 间接依赖 electron 的 net/session（仅在请求时才用）。
// 单测只验证请求体映射，不发起网络请求，因此用最小 mock 占位。
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), closeAllConnections: vi.fn() } },
}))

import { ChatCompletionsAdapter } from './ChatCompletionsAdapter'
import { ResponsesAdapter } from './ResponsesAdapter'
import type { CanonicalModelRequest } from '../../shared/types/provider'

// 写一个真实临时文件，让 Adapter 的 readImageDataUrl 能读到字节
function writeTempImage(bytes: Buffer, ext: string): string {
  const p = join(tmpdir(), `openchat-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  fs.writeFileSync(p, bytes)
  return p
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])

interface Buildable { buildRequest(request: CanonicalModelRequest): unknown }

describe('ChatCompletionsAdapter — 多模态映射', () => {
  const adapter = new ChatCompletionsAdapter({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    toolCalling: true,
    imageInput: true,
  })

  it('capabilities.supportsImageInput follows config.imageInput', () => {
    expect(adapter.capabilities.supportsImageInput).toBe(true)
    const off = new ChatCompletionsAdapter({ baseUrl: 'x', apiKey: 'k', toolCalling: true, imageInput: false })
    expect(off.capabilities.supportsImageInput).toBe(false)
  })

  it('maps inputParts to multipart content with image_url data URL', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: '看图', inputParts: [
          { type: 'text', text: '看图' },
          { type: 'image', attachmentId: 'att-1', detail: 'high' },
        ] },
      ],
      attachmentResolver: {
        resolveForProvider: (id) => id === 'att-1'
          ? { storagePath: path, mimeType: 'image/png', width: 12, height: 12, detail: 'auto' }
          : null,
      },
    }
    const body = (adapter as unknown as Buildable).buildRequest(req) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const userMsg = body.messages.find((m) => m.role === 'user')!
    expect(Array.isArray(userMsg.content)).toBe(true)
    const parts = userMsg.content as Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>
    expect(parts[0]).toEqual({ type: 'text', text: '看图' })
    expect(parts[1].type).toBe('image_url')
    expect(parts[1].image_url!.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(parts[1].image_url!.detail).toBe('high')

    fs.unlinkSync(path)
  })

  it('throws when resolver cannot find the attachment (no silent text fallback)', () => {
    const req: CanonicalModelRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: '看图', inputParts: [
          { type: 'text', text: '看图' },
          { type: 'image', attachmentId: 'missing' },
        ] },
      ],
      attachmentResolver: { resolveForProvider: () => null },
    }
    expect(() => (adapter as unknown as Buildable).buildRequest(req))
      .toThrow(/图片附件无法解析/)
  })

  it('throws when image part present but adapter does not support image input', () => {
    const noImage = new ChatCompletionsAdapter({ baseUrl: 'x', apiKey: 'k', toolCalling: true, imageInput: false })
    const req: CanonicalModelRequest = {
      model: 'text-only',
      messages: [
        { role: 'user', content: '看图', inputParts: [
          { type: 'text', text: '看图' },
          { type: 'image', attachmentId: 'att-1' },
        ] },
      ],
      attachmentResolver: { resolveForProvider: () => ({ storagePath: '/x/y.png', mimeType: 'image/png', width: 1, height: 1 }) },
    }
    expect(() => (noImage as unknown as Buildable).buildRequest(req))
      .toThrow(/不支持图片输入/)
  })

  it('keeps text-only messages as plain string content', () => {
    const req: CanonicalModelRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '纯文本' }],
    }
    const body = (adapter as unknown as Buildable).buildRequest(req) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages[0].content).toBe('纯文本')
  })
})

describe('ResponsesAdapter — 多模态映射', () => {
  const adapter = new ResponsesAdapter({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    toolCalling: true,
    imageInput: true,
  })

  it('capabilities.supportsImageInput follows config.imageInput', () => {
    expect(adapter.capabilities.supportsImageInput).toBe(true)
  })

  it('maps inputParts to input_text / input_image items', () => {
    const path = writeTempImage(PNG_BYTES, 'png')
    const req: CanonicalModelRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: '看图', inputParts: [
          { type: 'text', text: '看图' },
          { type: 'image', attachmentId: 'att-1' },
        ] },
      ],
      attachmentResolver: {
        resolveForProvider: () => ({ storagePath: path, mimeType: 'image/png', width: 1, height: 1, detail: 'low' }),
      },
    }
    const body = (adapter as unknown as Buildable).buildRequest(req) as {
      input: Array<{ role?: string; content: Array<{ type: string; text?: string; image_url?: string; detail?: string }> }>
    }
    const msg = body.input.find((i) => i.role === 'user')!
    expect(msg.content[0]).toEqual({ type: 'input_text', text: '看图' })
    expect(msg.content[1].type).toBe('input_image')
    expect(msg.content[1].image_url!.startsWith('data:image/png;base64,')).toBe(true)
    expect(msg.content[1].detail).toBe('low')

    fs.unlinkSync(path)
  })

  it('throws when image file cannot be read (no silent text fallback)', () => {
    const req: CanonicalModelRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: '看图', inputParts: [
          { type: 'text', text: '看图' },
          { type: 'image', attachmentId: 'att-1' },
        ] },
      ],
      attachmentResolver: { resolveForProvider: () => ({ storagePath: '/nonexistent/nope.png', mimeType: 'image/png', width: 1, height: 1 }) },
    }
    expect(() => (adapter as unknown as Buildable).buildRequest(req))
      .toThrow(/图片文件读取失败/)
  })

  it('throws when image part present but adapter does not support image input', () => {
    const noImage = new ResponsesAdapter({ baseUrl: 'x', apiKey: 'k', toolCalling: true, imageInput: false })
    const req: CanonicalModelRequest = {
      model: 'text-only',
      messages: [
        { role: 'user', content: '看图', inputParts: [
          { type: 'text', text: '看图' },
          { type: 'image', attachmentId: 'att-1' },
        ] },
      ],
      attachmentResolver: { resolveForProvider: () => ({ storagePath: '/x/y.png', mimeType: 'image/png', width: 1, height: 1 }) },
    }
    expect(() => (noImage as unknown as Buildable).buildRequest(req))
      .toThrow(/不支持图片输入/)
  })
})
