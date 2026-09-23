import { describe, it, expect } from 'vitest'
import {
  formatShortcut,
  SEARCH_CONVERSATIONS_SHORTCUT,
  NEW_CONVERSATION_SHORTCUT,
} from './shortcut'

// formatShortcut 是纯函数（平台由参数注入），可在 node 环境下直接断言。
describe('formatShortcut', () => {
  it('renders macOS symbols without separators', () => {
    expect(formatShortcut(SEARCH_CONVERSATIONS_SHORTCUT, true)).toBe('⇧⌘F')
    expect(formatShortcut(NEW_CONVERSATION_SHORTCUT, true)).toBe('⌘N')
  })

  it('renders Windows/Linux with Ctrl and plus separators', () => {
    expect(formatShortcut(SEARCH_CONVERSATIONS_SHORTCUT, false)).toBe('Ctrl+Shift+F')
    expect(formatShortcut(NEW_CONVERSATION_SHORTCUT, false)).toBe('Ctrl+N')
  })

  it('never shows Ctrl on macOS nor ⌘ on Windows/Linux', () => {
    expect(formatShortcut(SEARCH_CONVERSATIONS_SHORTCUT, true)).not.toContain('Ctrl')
    expect(formatShortcut(SEARCH_CONVERSATIONS_SHORTCUT, false)).not.toContain('⌘')
  })

  it('orders modifiers option, shift, command on macOS', () => {
    expect(formatShortcut({ mod: true, shift: true, alt: true, key: 'F' }, true)).toBe('⌥⇧⌘F')
  })

  it('does not duplicate Ctrl when both mod and ctrl are set on non-mac', () => {
    expect(formatShortcut({ mod: true, ctrl: true, shift: true, key: 'F' }, false)).toBe('Ctrl+Shift+F')
  })
})
