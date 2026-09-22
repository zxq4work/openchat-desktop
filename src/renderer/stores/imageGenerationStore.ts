import { create } from 'zustand'

// 图片生成是独立协议，不与 chatStreamStore 共享流式状态。
// 只跟踪"当前是否有一次进行中的图片生成"，用于 Composer Stop 按钮与占位骨架。
export type ImageGenerationPhase = 'idle' | 'generating'

// 生成失败的具体原因落在 assistant message 上（errorCode/errorMessage）并内联展示，
// store 只负责结束 generating 态，不重复承载错误文案，避免同一错误两处提示。
interface ImageGenerationState {
  conversationId: string | null
  // 正在生成的 assistant 消息 id：驱动 Composer / 滚动等"是否有活动生成"的逻辑。
  activeAssistantMessageId: string | null
  // 等待 UI handoff 的 assistant 消息 id：在 setCompleted 时【不清除】，
  // 直到该消息真正带上 generation_output 附件为止。用于让占位骨架跨越
  // "网络已完成但异步 reload 尚未提交结果"的窗口继续显示，避免 占位→空白→图片 抖动。
  pendingAssistantMessageId: string | null
  // 本次生成请求的尺寸（如 "1024x1536"）。在 started 时刻从会话默认值捕获一次，
  // 生成期间不随会话设置变化；用于占位骨架按目标比例预留高度，避免落图时高度突变。
  // 与 pendingAssistantMessageId 同样在 completed 时保留、在 failed/reset 时清除。
  pendingSize: string | null
  phase: ImageGenerationPhase
  setStarted: (conversationId: string, assistantMessageId: string, pendingSize: string | null) => void
  setCompleted: (conversationId: string) => void
  setFailed: (conversationId: string) => void
  // 结果附件已在消息中渲染后，由 AssistantMessage 调用以结束占位 handoff。
  // 仅当传入 id 仍是当前 pending 时才清除，避免连续生成时误清新一轮。
  clearPending: (assistantMessageId: string) => void
  reset: () => void
}

export const useImageGenerationStore = create<ImageGenerationState>((set) => ({
  conversationId: null,
  activeAssistantMessageId: null,
  pendingAssistantMessageId: null,
  pendingSize: null,
  phase: 'idle',

  setStarted: (conversationId, assistantMessageId, pendingSize) =>
    set({
      conversationId,
      activeAssistantMessageId: assistantMessageId,
      pendingAssistantMessageId: assistantMessageId,
      pendingSize,
      phase: 'generating',
    }),
  // 网络生成完成：结束 generating 态，但保留 pendingAssistantMessageId / pendingSize，
  // 由 AssistantMessage 在结果附件到位后自行结束占位。绝不在此清空 pending，否则会出现
  // "占位消失 → 结果未到 → 空白" 的中间帧。
  setCompleted: (conversationId) =>
    set({ conversationId, activeAssistantMessageId: null, phase: 'idle' }),
  // 失败/停止：结果不会到达，必须立即结束占位，让 error/stopped UI 接管。
  setFailed: (conversationId) =>
    set({ conversationId, activeAssistantMessageId: null, pendingAssistantMessageId: null, pendingSize: null, phase: 'idle' }),
  clearPending: (assistantMessageId) =>
    set((s) =>
      s.pendingAssistantMessageId === assistantMessageId
        ? { pendingAssistantMessageId: null, pendingSize: null }
        : {}
    ),
  reset: () =>
    set({ conversationId: null, activeAssistantMessageId: null, pendingAssistantMessageId: null, pendingSize: null, phase: 'idle' }),
}))
