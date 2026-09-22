import type { ConversationType } from '../../shared/types/conversation'

// 运行状态（chat 流式 / 图片生成）的会话归属判定（纯函数，便于单测）。
// 核心不变量：某个会话的运行状态只能展示在它自己所属的会话视图里。
// 切换 activeConversation 只是切换「当前显示谁」，绝不把正在运行的任务状态转移给新会话。

export function ownsChatStream(
  conversationType: ConversationType | null | undefined,
  activeConversationId: string | null,
  streamingConversationId: string | null
): boolean {
  return (
    conversationType === 'chat' &&
    !!activeConversationId &&
    streamingConversationId === activeConversationId
  )
}

export function ownsImageGeneration(
  conversationType: ConversationType | null | undefined,
  activeConversationId: string | null,
  generationConversationId: string | null
): boolean {
  return (
    conversationType === 'image_generation' &&
    !!activeConversationId &&
    generationConversationId === activeConversationId
  )
}

// live answer（当前正在流式的正式回答）的唯一 owner 判定。
// 概念上：
//   isStreamOwner = message.conversationId === streamingConversationId
//                && message.id        === streamingAssistantMessageId
// 两个都匹配才成立（不能只用 OR / 只比 conversationId）。
// 理由：
//   - 一个 conversation 里有大量历史 assistant message，仅比 conversationId 会把 live
//     buffer 附加到历史消息上；
//   - activeAssistantMessageId 只是「当前 UI 焦点」，切换会话/重载不会可靠地恢复它，
//     不能作为 live 数据源归属依据；
//   - DB 里可能存在历史遗留的 status='streaming'（崩溃 / 强制退出 / 旧版本），
//     因此绝不能仅凭 message.status==='streaming' 就认定它是 live owner。
// 真正的 owner 只能来自 Main 创建本轮 assistant message 时返回的稳定 id
// （streamingAssistantMessageId），该 id 一直保留到 turn-completed / error / interrupt / reset。
export function isStreamOwner(
  messageConversationId: string,
  messageId: string,
  streamingConversationId: string | null,
  streamingAssistantMessageId: string | null
): boolean {
  return (
    !!streamingAssistantMessageId &&
    !!streamingConversationId &&
    messageConversationId === streamingConversationId &&
    messageId === streamingAssistantMessageId
  )
}

// 某条 assistant 消息最终采用的正文（唯一事实源）：
//   - 本消息是 live owner（双匹配）→ 直接用 live answer（bufferedText）。
//     绝不叠加 persisted message.content —— 否则 DB 中途落盘的累积正文会被重复拼接，
//     每次 hydrate 都会把已经写入 DB 的前缀再拼一遍（ABC → ABABC → ABCABC）。
//   - 否则 → 使用 persisted message.content（历史消息 / 已完成的 turn）。
// 注意：substring/重复拼接都会破坏「单调增长」不变量，这里用 data source 二选一予以杜绝。
export function selectAnswerContent(
  persistedContent: string,
  streamedAnswer: string,
  isOwner: boolean
): string {
  return isOwner ? streamedAnswer : persistedContent
}

export interface WaitingIndicatorInput {
  // 本消息是否是当前 live stream 的 owner（isStreamOwner 的结果）。
  isLiveOwner: boolean
  conversationType: ConversationType | null | undefined
  messageStatus: string
  // 用户此刻实际能看到的正式 answer 正文是否非空（== 采用的正文 trim 后非空）。
  // reasoning 文本不计入 —— 思考阶段正文仍为空，等待提示应继续存在。
  hasVisibleAnswerContent: boolean
}

// 唯一的「等待回答」指示判定。
// 必须同时满足：
//   - 本消息是 live owner（真在生成，而不是历史遗留的 streaming 状态）；
//   - chat 会话（图片会话有自己的「正在生成图片」占位，绝不显示聊天等待提示）；
//   - status 处于 in-flight：'pending'（渲染进程乐观消息的初始态）或 'streaming'
//     （Main 落库/切回后 hydrate 到的态）。两者都代表「本轮尚未产出正式正文」；
//   - 尚无可见 answer 正文 —— 第一段正文出现后立即消失。
// 不满足时返回 false。这是全局唯一的 waiting UI 判据，替代原先的 statusBadge 与 content fallback。
export function shouldShowWaitingIndicator(input: WaitingIndicatorInput): boolean {
  const { isLiveOwner, conversationType, messageStatus, hasVisibleAnswerContent } = input
  const inFlight = messageStatus === 'pending' || messageStatus === 'streaming'
  return (
    isLiveOwner &&
    conversationType === 'chat' &&
    inFlight &&
    !hasVisibleAnswerContent
  )
}
