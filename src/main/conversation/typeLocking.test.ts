import { describe, it, expect } from 'vitest'
import { resolveProviderSwitch } from './typeLocking'

describe('resolveProviderSwitch', () => {
  describe('chat conversation', () => {
    it('switching to another chat provider just updates provider', () => {
      const action = resolveProviderSwitch({ currentType: 'chat', nextIsImageProvider: false, hasMessages: true })
      expect(action.kind).toBe('update-provider')
    })

    it('empty chat conversation can lock to image generation', () => {
      const action = resolveProviderSwitch({ currentType: 'chat', nextIsImageProvider: true, hasMessages: false })
      expect(action.kind).toBe('lock-image')
    })

    it('chat conversation with messages cannot become image generation', () => {
      const action = resolveProviderSwitch({ currentType: 'chat', nextIsImageProvider: true, hasMessages: true })
      expect(action.kind).toBe('reject')
      if (action.kind === 'reject') {
        expect(action.reason).toContain('不能切换为图片生成')
      }
    })
  })

  describe('image_generation conversation', () => {
    it('switching to another image provider just updates provider (even with messages)', () => {
      const action = resolveProviderSwitch({ currentType: 'image_generation', nextIsImageProvider: true, hasMessages: true })
      expect(action.kind).toBe('update-provider')
    })

    it('empty image conversation can switch back to chat', () => {
      const action = resolveProviderSwitch({ currentType: 'image_generation', nextIsImageProvider: false, hasMessages: false })
      expect(action.kind).toBe('unlock-to-chat')
    })

    it('image conversation with messages cannot switch back to chat', () => {
      const action = resolveProviderSwitch({ currentType: 'image_generation', nextIsImageProvider: false, hasMessages: true })
      expect(action.kind).toBe('reject')
      if (action.kind === 'reject') {
        expect(action.reason).toContain('不能切换为聊天')
      }
    })
  })

  it('lock/unlock are never reachable once messages exist in the destination type', () => {
    // 有消息时任何跨类型切换都必须被拒绝
    expect(resolveProviderSwitch({ currentType: 'chat', nextIsImageProvider: true, hasMessages: true }).kind).toBe('reject')
    expect(resolveProviderSwitch({ currentType: 'image_generation', nextIsImageProvider: false, hasMessages: true }).kind).toBe('reject')
  })
})
