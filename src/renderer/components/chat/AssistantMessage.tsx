import React, { useState, useRef, useEffect } from 'react'
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
  const [searchExpanded, setSearchExpanded] = useState(false)
  const liveTextRef = useRef<HTMLDivElement>(null)

  const webSearch = streamState.webSearchStatus
  const showWebSearch = isStreaming && webSearch.active && webSearch.callId !== null

  // 搜索结果：流式时优先用 store 中的实时结果，否则用持久化数据
  const searchResults = isStreaming && webSearch.results.length > 0
    ? webSearch.results
    : message.webSearchResults ?? []
  const hasSearchResults = searchResults.length > 0

  const rawContent = isStreaming ? message.content + streamState.bufferedText : message.content

  // 推理状态：优先取流式状态，否则取 DB 持久化的 reasoningMeta
  const reasoningMeta = isStreaming && streamState.reasoningMeta
    ? streamState.reasoningMeta
    : message.reasoningMeta

  const thinkingActive = isStreaming && streamState.reasoningStatus === 'thinking'
  const hasReasoning = !!reasoningMeta
  const hasSummary = hasReasoning && reasoningMeta.available && reasoningMeta.summary.length > 0
  const displaySeconds = thinkingActive ? streamState.reasoningElapsedSeconds : (hasReasoning ? Math.round(reasoningMeta.duration / 1000) : 0)
  const reasoningLiveText = thinkingActive ? streamState.reasoningText : ''

  // 思考中：实时内容增长时自动滚动到最新一行
  useEffect(() => {
    if (thinkingActive && liveTextRef.current) {
      liveTextRef.current.scrollTop = liveTextRef.current.scrollHeight
    }
  }, [reasoningLiveText, thinkingActive])

  const statusBadge = message.status === 'streaming' ? '生成中...' :
    message.status === 'stopped' ? '已停止' :
    message.status === 'failed' ? '失败' : null

  const modelInfo = message.modelId ? (
    <span className="message-model-info">
      {message.modelId}{message.reasoningEffort ? ` · ${message.reasoningEffort}` : ''}
    </span>
  ) : null

  return (
    <div className="message assistant-message" data-message-id={message.id}>
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
          {/* 思考中：实时展示思考内容（始终展开） */}
          {thinkingActive && reasoningLiveText && (
            <div className="message-thinking-content">
              <div className="message-thinking-live-text" ref={liveTextRef}>{reasoningLiveText}</div>
            </div>
          )}
          {/* 思考结束：折叠为推理摘要，点击展开 */}
          {!thinkingActive && hasSummary && summaryExpanded && (
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

      {/* 搜索参考页面列表 — 放在思考下面 */}
      {/* 网页搜索状态区域 */}
      {showWebSearch && (
        <div className="message-web-search">
          <svg className="message-web-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          <span className="message-web-search-query">
            {webSearch.toolName === 'openchat_web_fetch'
              ? (webSearch.query ? `正在读取：${webSearch.query}` : '正在读取网页...')
              : (webSearch.query ? `正在搜索：${webSearch.query}` : '正在搜索网页...')
            }
          </span>
        </div>
      )}
      {isStreaming && webSearch.error && (
        <div className="message-web-search-error">{webSearch.error}</div>
      )}
      {hasSearchResults && (
        <div className="message-search-results">
          <div
            className="message-search-results-header"
            onClick={() => setSearchExpanded(!searchExpanded)}
          >
            <span className="message-search-results-icon">&#128269;</span>
            <span>{searchResults.every((r) => r.sourceType === 'api') ? `${searchResults.length} 个数据源` : `搜索到 ${searchResults.length} 个参考页面`}</span>
            <span className="message-search-results-arrow">
              {searchExpanded ? '▾' : '▸'}
            </span>
          </div>
          {searchExpanded && (
            <ul className="message-search-results-list">
              {searchResults.map((item, i) => (
                <li key={i} className={`message-search-result-item${item.sourceType === 'api' ? ' message-search-result-api' : ''}`}>
                  {item.sourceType === 'api' ? (
                    <span className="message-search-result-title message-search-result-api-title">
                      {item.title || '内置服务'}
                    </span>
                  ) : item.url ? (
                    <a
                      className="message-search-result-title"
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => {
                        e.preventDefault()
                        window.openchat.openExternal(item.url!)
                      }}
                    >
                      {item.title || item.url}
                    </a>
                  ) : item.title ? (
                    <span className="message-search-result-title">{item.title}</span>
                  ) : null}
                  {item.url && (
                    <div className="message-search-result-url">{item.url}</div>
                  )}
                  {item.snippet && (
                    <p className="message-search-result-snippet">{item.snippet}</p>
                  )}
                </li>
              ))}
            </ul>
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