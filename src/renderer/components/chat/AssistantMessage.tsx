import React, { useState } from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { MarkdownRenderer } from '../MarkdownRenderer'

interface Props {
  message: Message
}

export const AssistantMessage = React.memo(function AssistantMessage({ message }: Props) {
  const streamState = useChatStreamStore()
  const isStreaming = streamState.activeAssistantMessageId === message.id && streamState.status === 'streaming'
  const [summaryExpanded, setSummaryExpanded] = useState(false)

  const rawContent = isStreaming ? message.content + streamState.bufferedText : message.content

  // 推理状态：优先取流式状态，否则取 DB 持久化的 reasoningMeta
  const reasoningMeta = isStreaming && streamState.reasoningMeta
    ? streamState.reasoningMeta
    : message.reasoningMeta

  const thinkingActive = isStreaming && streamState.reasoningStatus === 'thinking'
  const hasReasoning = !!reasoningMeta
  const hasSummary = hasReasoning && reasoningMeta.available && reasoningMeta.summary.length > 0
  const displaySeconds = thinkingActive ? streamState.reasoningElapsedSeconds : (hasReasoning ? Math.round(reasoningMeta.duration / 1000) : 0)

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

      {/* 推理状态区域 */}
      {(thinkingActive || hasReasoning) && (
        <div className="message-thinking">
          <div
            className="message-thinking-header"
            onClick={() => hasSummary && setSummaryExpanded(!summaryExpanded)}
            style={hasSummary ? { cursor: 'pointer' } : undefined}
          >
            <span className="message-thinking-icon">
              {thinkingActive ? '\u25CF' : '\u2713'}
            </span>
            <span>
              {thinkingActive
                ? `\u6B63\u5728\u601D\u8003\u2026 ${displaySeconds}\u79D2`
                : `\u5DF2\u601D\u8003 ${displaySeconds} \u79D2`
              }
            </span>
            {hasSummary && (
              <span className="message-thinking-arrow">
                {summaryExpanded ? '▾' : '▸'}
              </span>
            )}
          </div>
          {hasSummary && summaryExpanded && (
            <div className="message-thinking-content">
              <div className="message-thinking-summary-title">推理摘要</div>
              <ul className="message-thinking-summary-list">
                {reasoningMeta.summary.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="message-content">
        {rawContent ? (
          <MarkdownRenderer>{rawContent}</MarkdownRenderer>
        ) : isStreaming ? (
          <div>...</div>
        ) : null}
      </div>
      {statusBadge && <div className="message-status">{statusBadge}</div>}
      {message.errorCode && (
        <div className="message-error">
          {message.errorCode}: {message.errorMessage}
        </div>
      )}
    </div>
  )
})