import type { Conversation, Message } from '../../shared/types/conversation'
import type { ModelInfo } from '../../shared/types/model'
import { imageAttachments } from './attachmentUrl'
import { supportsImageFromModalities } from '../../shared/utils/imageCapability'

interface ProviderLike {
  id: string
  imageInput?: boolean
}

// 能力判定（与 Main 侧 modelSupportsImage 保持一致）：
// - 自定义 Provider：以用户在设置中显式声明的 imageInput 为准（绝不从模型名猜测）
// - Codex 内置：以模型 metadata 的 inputModalities 为准（三态语义，见 supportsImageFromModalities）
//   inputModalities 缺失 = 能力未知 = 不阻止图片；只有明确返回不含 'image' 的数组才阻止。
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
  return !!model && supportsImageFromModalities(model.inputModalities)
}

// 当前 segment 内是否已有历史图片需要 replay（用于发送前能力提示）。
// 只统计 Chat 图片输入（usage=chat_input）：图片生成的参考图/结果不进入 Chat 上下文，
// 因此不应触发「模型需支持图片输入」的能力门禁。
export function historyHasImage(messages: Message[]): boolean {
  return messages.some(
    (m) => m.role === 'user' && imageAttachments(m.attachments).some((a) => a.usage === 'chat_input')
  )
}
