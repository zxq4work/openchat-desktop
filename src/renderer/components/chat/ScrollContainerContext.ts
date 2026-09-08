import { createContext } from 'react'

// 外层消息列表的滚动跟随模式。
// FOLLOWING: 自动跟随最新内容，允许 answer/reasoning/search 状态变化自动滚动到底部
// READING_HISTORY: 用户正在阅读历史内容，所有自动滚动禁止
export type ScrollFollowMode = 'FOLLOWING' | 'READING_HISTORY'

// 内外层滚动联动控制器。
// 内层 ReasoningPanel 用户主动向上滚动、或 Codex Summary 用户主动展开时，
// 需要通知外层 MessageList 进入阅读模式，否则 answer delta 会继续触发
// scrollToBottom，把正在看的思考内容推走。
export interface ScrollController {
  // 进入阅读历史模式，reason 用于诊断（如 'reasoning-panel-scroll' / 'summary-expand'）
  enterReadingMode: (reason: string) => void
  // 恢复自动跟随
  resumeFollowing: () => void
  // 当前跟随模式
  getMode: () => ScrollFollowMode
}

export const ScrollContainerContext = createContext<ScrollController>({
  enterReadingMode: () => {},
  resumeFollowing: () => {},
  getMode: () => 'FOLLOWING',
})
