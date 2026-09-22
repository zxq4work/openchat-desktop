import { describe, it, expect } from 'vitest'
import type { Message, MessageAttachment } from '../../shared/types/conversation'
import { deriveConversationPreviewImages, wrapIndex } from './conversationPreviewImages'

function att(id: string, over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id,
    messageId: 'm',
    conversationId: 'c',
    segmentId: 's',
    type: 'image',
    mimeType: 'image/png',
    fileName: `${id}.png`,
    fileSize: 100,
    width: 10,
    height: 10,
    detail: 'auto',
    sha256: 'x',
    source: 'user_upload',
    usage: 'chat_input',
    createdAt: 0,
    ...over,
  }
}

function msg(id: string, attachments: MessageAttachment[]): Message {
  return { id, attachments } as unknown as Message
}

describe('deriveConversationPreviewImages', () => {
  it('keeps message order then attachment order, no id/createdAt sorting', () => {
    const messages = [
      msg('m1', [att('b'), att('a')]),
      msg('m2', []),
      msg('m3', [att('z')]),
    ]
    const out = deriveConversationPreviewImages(messages)
    expect(out.map((i) => i.attachmentId)).toEqual(['b', 'a', 'z'])
    expect(out.map((i) => i.messageId)).toEqual(['m1', 'm1', 'm3'])
  })

  it('includes chat_input / generation_input / generation_output', () => {
    const messages = [
      msg('m1', [
        att('a', { usage: 'chat_input' }),
        att('b', { usage: 'generation_input' }),
        att('c', { usage: 'generation_output' }),
      ]),
    ]
    const out = deriveConversationPreviewImages(messages)
    expect(out.map((i) => i.usage)).toEqual(['chat_input', 'generation_input', 'generation_output'])
  })

  it('excludes non-image attachments', () => {
    // 类型系统层面只有 image，但仍防御性过滤
    const messages = [msg('m1', [att('a'), { ...att('b'), type: 'file' as 'image' }])]
    const out = deriveConversationPreviewImages(messages)
    expect(out.map((i) => i.attachmentId)).toEqual(['a'])
  })

  it('produces protocol urls for both original and thumbnail', () => {
    const out = deriveConversationPreviewImages([msg('m1', [att('a')])])
    expect(out[0].originalUrl).toBe('openchat-attachment://original/a')
    expect(out[0].thumbnailUrl).toBe('openchat-attachment://thumbnail/a')
  })
})

describe('wrapIndex', () => {
  it('wraps forward past the end', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0)
  })

  it('wraps backward past the start', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2)
  })

  it('returns -1 for empty sequence', () => {
    expect(wrapIndex(0, 1, 0)).toBe(-1)
  })

  it('wraps by one', () => {
    expect(wrapIndex(1, 1, 2)).toBe(0)
  })
})
