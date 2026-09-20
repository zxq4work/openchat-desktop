import type { Conversation, Message } from '../../shared/types/conversation'
import type { ModelInfo } from '../../shared/types/model'
import { imageAttachments } from './attachmentUrl'

interface ProviderLike {
  id: string
  imageInput?: boolean
}

// 能力判定（与 Main 侧 modelSupportsImage 保持一致）：
// - 自定义 Provider：以用户在设置中显式声明的 imageInput 为准（绝不从模型名猜测）
// - Codex 内置：以模型 metadata 的 inputModalities 为准
// - 未知：视为不支持（text only）
export function modelSupportsImage(
  conversation: Conversation | null,
  models: ModelInfo[],
  providers: ProviderLike[]
): boolean {
  if (!conversation) return false
  if (conversation.providerConfigId) {
    const provider = providers.find((p) => p.id === conversation.providerConfigId)
    return provider?.imageInput ?? false
  }
  const model = models.find((m) => m.id === conversation.defaultModelId)
  return !!model && (model.inputModalities ?? []).includes('image')
}

// 当前 segment 内是否已有历史图片需要 replay（用于发送前能力提示）
export function historyHasImage(messages: Message[]): boolean {
  return messages.some((m) => m.role === 'user' && imageAttachments(m.attachments).length > 0)
}
