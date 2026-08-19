import React, { useMemo, useState } from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { renderMarkdown } from '../../utils/markdown'

interface Props {
  message: Message
}

export const AssistantMessage = React.memo(function AssistantMessage({ message }: Props) {
  const streamState = useChatStreamStore()
  const isStreaming = streamState.activeAssistantMessageId === message.id && streamState.status === 'streaming'
  const [thinkingExpanded, setThinkingExpanded] = useState(false)

  const rawContent = isStreaming ? message.content + streamState.bufferedText : message.content

  const rawReasoning = isStreaming
    ? (message.reasoningContent ?? '') + streamState.bufferedReasoningText
    : (message.reasoningContent ?? '')

  const htmlContent = useMemo(() => renderMarkdown(rawContent), [rawContent])

  const statusBadge = message.status === 'streaming' ? '生成中...' :
    message.status === 'stopped' ? '已停止' :
    message.status === 'failed' ? '失败' : null

  const modelInfo = message.modelId ? (
    <span className="message-model-info">
      {message.modelId}{message.reasoningEffort ? ` · ${message.reasoningEffort}` : ''}
    </span>
  ) : null

  return (
    <div className="message assistant-message">
      <div className="message-role">
        Assistant
        {modelInfo}
      </div>
      {rawReasoning && (
        <div className="message-thinking">
          <div
            className="message-thinking-header"
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
          >
            <span className="message-thinking-arrow">{thinkingExpanded ? '▾' : '▸'}</span>
            <span>思考过程</span>
          </div>
          {thinkingExpanded && (
            <div className="message-thinking-content">{rawReasoning}</div>
          )}
        </div>
      )}
      <div
        className="message-content markdown-body"
        dangerouslySetInnerHTML={{ __html: htmlContent || (isStreaming ? '...' : '') }}
      />
      {statusBadge && <div className="message-status">{statusBadge}</div>}
      {message.errorCode && (
        <div className="message-error">
          {message.errorCode}: {message.errorMessage}
        </div>
      )}
    </div>
  )
})