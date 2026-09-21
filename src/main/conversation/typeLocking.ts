import type { ConversationType } from '../../shared/types/conversation'

// 会话类型锁定策略（纯函数，便于单测）。
// 核心不变量：一旦会话产生过消息，ConversationType 不可再改变。
// chat 与 image_generation 使用完全不同的 Provider 协议，切换会导致历史语义崩溃。
// 空会话（无消息）允许切换；有消息后仅允许在同类型内更换 Provider。
export type ProviderSwitchAction =
  | { kind: 'update-provider' }        // 仅更新 providerConfigId，类型不变
  | { kind: 'lock-image' }             // chat → image_generation（锁定）
  | { kind: 'unlock-to-chat' }         // image_generation → chat（仅空会话）
  | { kind: 'reject'; reason: string }

export function resolveProviderSwitch(params: {
  currentType: ConversationType
  nextIsImageProvider: boolean
  hasMessages: boolean
}): ProviderSwitchAction {
  const { currentType, nextIsImageProvider, hasMessages } = params

  if (currentType === 'image_generation') {
    if (nextIsImageProvider) return { kind: 'update-provider' }
    if (hasMessages) return { kind: 'reject', reason: '图片生成会话已有内容，不能切换为聊天' }
    return { kind: 'unlock-to-chat' }
  }

  // currentType === 'chat'
  if (nextIsImageProvider) {
    if (hasMessages) return { kind: 'reject', reason: '会话已有消息，不能切换为图片生成' }
    return { kind: 'lock-image' }
  }
  return { kind: 'update-provider' }
}
