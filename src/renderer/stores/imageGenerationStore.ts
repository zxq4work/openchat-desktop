import { create } from 'zustand'

// 图片生成是独立协议，不与 chatStreamStore 共享流式状态。
// 只跟踪"当前是否有一次进行中的图片生成"，用于 Composer Stop 按钮与占位骨架。
export type ImageGenerationPhase = 'idle' | 'generating'

// 生成失败的具体原因落在 assistant message 上（errorCode/errorMessage）并内联展示，
// store 只负责结束 generating 态，不重复承载错误文案，避免同一错误两处提示。
interface ImageGenerationState {
  conversationId: string | null
  activeAssistantMessageId: string | null
  phase: ImageGenerationPhase
  setStarted: (conversationId: string, assistantMessageId: string) => void
  setCompleted: (conversationId: string) => void
  setFailed: (conversationId: string) => void
  reset: () => void
}

export const useImageGenerationStore = create<ImageGenerationState>((set) => ({
  conversationId: null,
  activeAssistantMessageId: null,
  phase: 'idle',

  setStarted: (conversationId, assistantMessageId) =>
    set({ conversationId, activeAssistantMessageId: assistantMessageId, phase: 'generating' }),
  setCompleted: (conversationId) =>
    set({ conversationId, activeAssistantMessageId: null, phase: 'idle' }),
  setFailed: (conversationId) =>
    set({ conversationId, activeAssistantMessageId: null, phase: 'idle' }),
  reset: () => set({ conversationId: null, activeAssistantMessageId: null, phase: 'idle' }),
}))
