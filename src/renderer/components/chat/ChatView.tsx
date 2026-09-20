import React, { useEffect, useMemo } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'
import { MessageList } from './MessageList'
import { Composer } from '../composer/Composer'
import { SearchBar } from './SearchBar'
import {
  DIAG_ENABLE_CONVERSATION_KEEP_ALIVE,
  DIAG_PANE_RENDERING_ISOLATION,
  keepAliveGetPaneIdsToMount,
  keepAliveIsCurrent,
  keepAliveGetPreviousEntry,
} from '../../packages/conversationKeepAlive'
import type { Conversation, ContextSegment, Message } from '../../../shared/types/conversation'

export function ChatView() {
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const activeMessages = useConversationStore((s) => s.activeMessages)
  const activeSegments = useConversationStore((s) => s.activeSegments)
  const searchVisible = useUiStore((s) => s.searchVisible)
  const closeSearch = useUiStore((s) => s.closeSearch)

  // 切换对话时关闭搜索栏
  useEffect(() => {
    closeSearch()
  }, [activeConversationId, closeSearch])

  // Keep-alive 模式：渲染 current + previous 双 pane
  // paneIds 由 ConversationItem.handleClick 调用 keepAliveRotateIn 后更新
  // 这里用 activeConversationId 作为 re-render 触发器（rotate 后 store 也变了）
  const paneIds = useMemo(() => {
    if (!DIAG_ENABLE_CONVERSATION_KEEP_ALIVE) return []
    return keepAliveGetPaneIdsToMount()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId])

  if (!activeConversation) {
    return (
      <div className="chat-view empty">
        <div className="empty-state">
          <h2>OpenChat Desktop</h2>
          <p>选择左侧对话或创建新对话开始聊天</p>
        </div>
      </div>
    )
  }

  // 非 keep-alive 模式：原始单 MessageList 路径
  if (!DIAG_ENABLE_CONVERSATION_KEEP_ALIVE) {
    return (
      <div className="chat-view">
        <div className="chat-header">
          <span className="chat-title">{activeConversation.title}</span>
        </div>
        {searchVisible && <SearchBar />}
        <MessageList />
        <Composer />
      </div>
    )
  }

  // Keep-alive 模式：pane stack
  // 每个 pane 用 conversationId 作为 key（稳定 identity，B→A 复用不 remount）
  // active pane 用 store 实时数据（流式时更新）
  // previous (hidden) pane 用 snapshot（rotateIn 时从 store 冻结的快照）
  const previousEntry = keepAliveGetPreviousEntry()

  return (
    <div className="chat-view">
      <div className="chat-header">
        <span className="chat-title">{activeConversation.title}</span>
      </div>
      {searchVisible && <SearchBar />}
      <div className="pane-cache-container">
        {paneIds.map((paneId) => {
          const isActive = keepAliveIsCurrent(paneId)
          // active pane：store 实时数据；previous pane：snapshot
          const paneConversation: Conversation | null = isActive
            ? activeConversation
            : previousEntry?.conversationId === paneId ? previousEntry.conversation : null
          const paneMessages: Message[] = isActive
            ? activeMessages
            : previousEntry?.conversationId === paneId ? previousEntry.messages : []
          const paneSegments: ContextSegment[] = isActive
            ? activeSegments
            : previousEntry?.conversationId === paneId ? previousEntry.segments : []

          if (!paneConversation) return null

          return (
            <div
              key={paneId}
              className={`pane-cache-pane${DIAG_PANE_RENDERING_ISOLATION ? ' pane-cache-pane-isolated' : ''}`}
              data-active={isActive ? 'true' : 'false'}
              aria-hidden={isActive ? undefined : true}
            >
              <MessageList
                conversationId={paneId}
                snapshotConversation={paneConversation}
                snapshotMessages={paneMessages}
                snapshotSegments={paneSegments}
                isActivePane={isActive}
              />
            </div>
          )
        })}
      </div>
      <Composer />
    </div>
  )
}
