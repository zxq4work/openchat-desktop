import { describe, it, expect } from 'vitest'
import { imageFilesFromDataTransfer } from './attachmentDraftIO'
import { modelSupportsImage, historyHasImage } from './imageCapability'
import type { Message } from '../../shared/types/conversation'

// v8 无 DOM 类型，这里手工构造最小 DataTransferItem 形状
interface FakeItem { kind: string; type: string; file: File | null; getAsFile: () => File | null }
function fakeDT(items: FakeItem[]) {
  return { items } as unknown as DataTransfer
}
function fakeFile(name: string, type: string): File {
  return { name, type } as File
}

describe('imageFilesFromDataTransfer', () => {
  it('extracts only file-kind items', () => {
    const dt = fakeDT([
      { kind: 'file', type: 'image/png', file: fakeFile('a.png', 'image/png'), getAsFile: () => fakeFile('a.png', 'image/png') },
      { kind: 'string', type: 'text/plain', file: null, getAsFile: () => null },
    ])
    const files = imageFilesFromDataTransfer(dt)
    expect(files.length).toBe(1)
    expect(files[0].name).toBe('a.png')
  })

  it('keeps image/* files', () => {
    const dt = fakeDT([
      { kind: 'file', type: 'image/webp', file: fakeFile('x.webp', 'image/webp'), getAsFile: () => fakeFile('x.webp', 'image/webp') },
    ])
    expect(imageFilesFromDataTransfer(dt).length).toBe(1)
  })

  it('filters out non-image file kinds', () => {
    const dt = fakeDT([
      { kind: 'file', type: 'application/pdf', file: fakeFile('doc.pdf', 'application/pdf'), getAsFile: () => fakeFile('doc.pdf', 'application/pdf') },
    ])
    expect(imageFilesFromDataTransfer(dt)).toEqual([])
  })

  it('returns empty for null', () => {
    expect(imageFilesFromDataTransfer(null)).toEqual([])
  })

  it('drops items whose getAsFile returns null', () => {
    const dt = fakeDT([
      { kind: 'file', type: 'image/png', file: null, getAsFile: () => null },
    ])
    expect(imageFilesFromDataTransfer(dt)).toEqual([])
  })
})

describe('modelSupportsImage', () => {
  it('defaults to false when no conversation', () => {
    expect(modelSupportsImage(null, [], [])).toBe(false)
  })

  it('Codex model supports image when inputModalities includes image', () => {
    const conv = { providerConfigId: null, defaultModelId: 'gpt-5' } as unknown as NonNullable<Parameters<typeof modelSupportsImage>[0]>
    const models = [{ id: 'gpt-5', inputModalities: ['text', 'image'] }]
    expect(modelSupportsImage(conv, models as never[], [])).toBe(true)
  })

  it('Codex model is text-only when inputModalities lacks image', () => {
    const conv = { providerConfigId: null, defaultModelId: 'gpt-5' } as unknown as NonNullable<Parameters<typeof modelSupportsImage>[0]>
    const models = [{ id: 'gpt-5', inputModalities: ['text'] }]
    expect(modelSupportsImage(conv, models as never[], [])).toBe(false)
  })

  it('Codex unknown model defaults to text-only (never guesses from name)', () => {
    const conv = { providerConfigId: null, defaultModelId: 'gpt-image-1' } as unknown as NonNullable<Parameters<typeof modelSupportsImage>[0]>
    expect(modelSupportsImage(conv, [], [])).toBe(false)
  })

  it('custom provider support comes from explicit imageInput flag, not model name', () => {
    const conv = { providerConfigId: 'p1', defaultModelId: 'whatever-vision' } as unknown as NonNullable<Parameters<typeof modelSupportsImage>[0]>
    const providers = [{ id: 'p1', imageInput: true }]
    expect(modelSupportsImage(conv, [], providers as never[])).toBe(true)
  })

  it('custom provider without flag defaults to text-only', () => {
    const conv = { providerConfigId: 'p1', defaultModelId: 'anything' } as unknown as NonNullable<Parameters<typeof modelSupportsImage>[0]>
    expect(modelSupportsImage(conv, [], [])).toBe(false)
  })
})

describe('historyHasImage', () => {
  const base: Message = {
    id: 'm1', conversationId: 'c1', segmentId: 's1', role: 'user', content: 'hi',
    attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
    webSearchResults: null, webSearchError: null, status: 'completed', modelId: null,
    reasoningEffort: null, providerTurnId: null, providerItemId: null, providerPayloadJson: null,
    errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
  }

  it('is false when no user message has images', () => {
    const msgs: Message[] = [
      { ...base, id: 'a', attachments: [] },
      { ...base, id: 'b', role: 'assistant', content: 'ok' },
    ]
    expect(historyHasImage(msgs)).toBe(false)
  })

  it('is true when a historical user message has a chat_input image attachment', () => {
    const msgs: Message[] = [
      { ...base, id: 'a', attachments: [{ id: 'att-1', type: 'image', usage: 'chat_input' } as never] },
      { ...base, id: 'b', role: 'assistant', content: 'ok' },
    ]
    expect(historyHasImage(msgs)).toBe(true)
  })

  it('ignores assistant attachments (only user replays images)', () => {
    const msgs: Message[] = [
      { ...base, id: 'b', role: 'assistant', attachments: [{ id: 'att-1', type: 'image', usage: 'generation_output' } as never], content: 'ok' },
    ]
    expect(historyHasImage(msgs)).toBe(false)
  })

  it('ignores generation_input / generation_output (not part of Chat context)', () => {
    const msgs: Message[] = [
      { ...base, id: 'a', attachments: [{ id: 'att-1', type: 'image', usage: 'generation_input' } as never] },
      { ...base, id: 'b', attachments: [{ id: 'att-2', type: 'image', usage: 'generation_output' } as never] },
    ]
    expect(historyHasImage(msgs)).toBe(false)
  })
})