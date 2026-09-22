import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSelectionMenu, buildMessageTextMenu, buildMessageImageMenu } from './messageMenu'

// 只验证 items 结构（label / id / 顺序）。onClick 内部依赖 window/navigator，
// 仅在需要时单独注入 fake 后调用。
describe('messageMenu builders', () => {
  it('selection menu → 复制 + 在浏览器中搜索', () => {
    const items = buildSelectionMenu('hello')
    expect(items.map((i) => i.label)).toEqual(['复制', '在浏览器中搜索'])
    expect(items.map((i) => i.id)).toEqual(['copy', 'search'])
  })

  it('no selection + text → 复制文本', () => {
    const items = buildMessageTextMenu('some markdown')
    expect(items.map((i) => i.label)).toEqual(['复制文本'])
    expect(items.map((i) => i.id)).toEqual(['copy-text'])
  })

  it('image + text → 复制图片 then 复制文本 (order fixed)', () => {
    const items = buildMessageImageMenu('att-1', 'caption text')
    expect(items.map((i) => i.label)).toEqual(['复制图片', '复制文本'])
    expect(items.map((i) => i.id)).toEqual(['copy-image', 'copy-text'])
  })

  it('image only → 复制图片, no text action', () => {
    expect(buildMessageImageMenu('att-1').map((i) => i.label)).toEqual(['复制图片'])
    expect(buildMessageImageMenu('att-1', '').map((i) => i.label)).toEqual(['复制图片'])
    expect(buildMessageImageMenu('att-1', '   ').map((i) => i.label)).toEqual(['复制图片'])
  })

  it('never exposes 复制整条消息 wording', () => {
    for (const items of [
      buildSelectionMenu('x'),
      buildMessageTextMenu('x'),
      buildMessageImageMenu('a', 'x'),
      buildMessageImageMenu('a'),
    ]) {
      expect(items.some((i) => i.label.includes('整条消息'))).toBe(false)
    }
  })
})

describe('copyText action', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('复制文本 copies the raw message content (not rendered DOM)', () => {
    const writeText = vi.fn()
    ;(globalThis as unknown as { navigator: unknown }).navigator = { clipboard: { writeText } }
    buildMessageTextMenu('# Title\n\n- a\n- b')[0].onClick()
    expect(writeText).toHaveBeenCalledWith('# Title\n\n- a\n- b')
  })

  it('复制 (selection) copies only the selected text', () => {
    const writeText = vi.fn()
    ;(globalThis as unknown as { navigator: unknown }).navigator = { clipboard: { writeText } }
    buildSelectionMenu('selected words')[0].onClick()
    expect(writeText).toHaveBeenCalledWith('selected words')
  })
})
