import React, { useState, useRef, useEffect, useCallback, useContext } from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useModelStore } from '../../stores/modelStore'
import { useImageGenerationStore } from '../../stores/imageGenerationStore'
import { useUiStore } from '../../stores/uiStore'
import { imageAttachments, thumbnailUrl } from '../../packages/attachmentUrl'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { ScrollContainerContext } from './ScrollContainerContext'
import { probeLayoutRead } from '../../packages/layoutReadDiag'

interface Props {
  message: Message
}

export const AssistantMessage = React.memo(function AssistantMessage({ message }: Props) {
  const streamState = useChatStreamStore()
  const isStreaming = streamState.activeAssistantMessageId === message.id && streamState.status === 'streaming'
  const openLightbox = useUiStore((s) => s.openLightbox)
  // 图片生成结果：assistant 消息此前不渲染 attachments，这里补齐图片网格。
  const generatedImages = imageAttachments(message.attachments)
  const imageGenActiveAssistantId = useImageGenerationStore((s) => s.activeAssistantMessageId)
  const isImageGenerating = imageGenActiveAssistantId === message.id
  const [summaryExpanded, setSummaryExpanded] = useState(
    // 当前 turn 的消息（非 completed）默认展开 reasoning 面板，避免 completion 时
    // summaryExpanded 从 false 切到 true 导致 DOM 卸载再挂载，scrollTop 归零。
    () => message.status !== 'completed'
  )
  const [searchExpanded, setSearchExpanded] = useState(false)
  const reasoningPanelRef = useRef<HTMLDivElement>(null)

  // reasoning 内部滚动：用户向上滚后不再强制跟随
  const reasoningPinnedRef = useRef(true)
  const [showReasoningScrollBtn, setShowReasoningScrollBtn] = useState(false)

  const scrollControl = useContext(ScrollContainerContext)

  const webSearch = streamState.webSearchStatus
  const showWebSearch = isStreaming && webSearch.active && webSearch.callId !== null

  const searchResults = isStreaming && webSearch.results.length > 0
    ? webSearch.results
    : message.webSearchResults ?? []
  const hasSearchResults = searchResults.length > 0

  // Answer 文本数据源：以 message.status 为准，而非 stream 的 isStreaming。
  // 关键：completion 时 message.status 变为 'completed'，rawContent 立即只取
  // message.content（已在同一 setActiveMessages 中原子写入完整文本），
  // 不再拼 bufferedText，避免「final content + old buffer」或「old content + empty buffer」
  // 的双 store 中间帧。
  const isMessageSettled = message.status === 'completed' || message.status === 'stopped' || message.status === 'failed'
  const rawContent = isMessageSettled
    ? message.content
    : message.content + streamState.bufferedText

  const codexModels = useModelStore((s) => s.models)
  const isCodex = !!message.modelId && codexModels.some((m) => m.id === message.modelId)

  const reasoningDisplayMode = (() => {
    // 当前流式消息：使用 store 中确定好的 displayMode（发送时由 Provider 能力确定）
    if (isStreaming) return streamState.reasoningDisplayMode
    // 历史消息：直接读取持久化的 displayMode，不再从 reasoningText/reasoningMeta 推断
    return message.reasoningDisplayMode
  })()

  // Live 模式数据源
  const liveReasoningText = (() => {
    if (reasoningDisplayMode !== 'live') return ''
    if (isStreaming && streamState.reasoningText) return streamState.reasoningText
    return message.reasoningText ?? ''
  })()

  // Summary 模式数据源
  const reasoningMeta = (() => {
    if (isStreaming && streamState.reasoningMeta) return streamState.reasoningMeta
    return message.reasoningMeta
  })()

  const hasSummary = reasoningMeta?.available && reasoningMeta.summary.length > 0

  const thinkingActive = isStreaming && streamState.reasoningStatus === 'thinking'

  // 仅在确实有推理数据可展示时才显示 reasoning panel，避免"已思考0秒"空壳
  const hasReasoning = (() => {
    if (reasoningDisplayMode === 'none') return false
    if (reasoningDisplayMode === 'summary') return hasSummary || thinkingActive
    return !!liveReasoningText || thinkingActive
  })()
  const displaySeconds = thinkingActive
    ? streamState.reasoningElapsedSeconds
    : (reasoningMeta ? Math.round(reasoningMeta.duration / 1000) : 0)

  // 流式期间始终展开无法折叠；非流式时由用户控制（summaryExpanded）
  const livePanelExpanded = isStreaming ? true : summaryExpanded
  const summaryExpandedEffective = isStreaming ? true : summaryExpanded

  // 用户点击 header 折叠/展开：Codex Summary 展开时暂停外层自动跟随
  const handleHeaderClick = useCallback(() => {
    if (isStreaming) return
    const next = !summaryExpanded
    setSummaryExpanded(next)
    if (next) {
      scrollControl.enterReadingMode('summary-expand')
    }
  }, [isStreaming, summaryExpanded, scrollControl])

  // Live reasoning 内部滚动处理：内层向上滚动时通知外层暂停自动跟随
  const handleReasoningPanelScroll = useCallback(() => {
    const panel = reasoningPanelRef.current
    if (!panel) return
    let t0 = performance.now()
    const scrollHeight = panel.scrollHeight
    probeLayoutRead(t0, 'AssistantMessage.reasoningScroll', 'scrollHeight')
    t0 = performance.now()
    const scrollTop = panel.scrollTop
    probeLayoutRead(t0, 'AssistantMessage.reasoningScroll', 'scrollTop')
    t0 = performance.now()
    const clientHeight = panel.clientHeight
    probeLayoutRead(t0, 'AssistantMessage.reasoningScroll', 'clientHeight')
    const dist = scrollHeight - scrollTop - clientHeight
    reasoningPinnedRef.current = dist < 40
    setShowReasoningScrollBtn(dist >= 120)
    if (dist >= 40) {
      scrollControl.enterReadingMode('reasoning-panel-scroll')
    }
  }, [scrollControl])

  const scrollReasoningToBottom = useCallback(() => {
    const panel = reasoningPanelRef.current
    if (!panel) return
    reasoningPinnedRef.current = true
    let t0 = performance.now()
    const scrollHeight = panel.scrollHeight
    probeLayoutRead(t0, 'AssistantMessage.scrollReasoningToBottom', 'scrollHeight')
    panel.scrollTop = scrollHeight
    setShowReasoningScrollBtn(false)
  }, [])

  // Live reasoning 自动跟随：内容增长时若贴底则滚到底部
  // 前置条件全部满足才允许读取 geometry，避免历史消息 mount / 折叠态触发 Forced Reflow
  useEffect(() => {
    if (!isStreaming) return
    if (reasoningDisplayMode !== 'live') return
    if (!livePanelExpanded) return
    if (!reasoningPinnedRef.current) return
    const panel = reasoningPanelRef.current
    if (!panel) return
    let t0 = performance.now()
    const scrollHeight = panel.scrollHeight
    probeLayoutRead(t0, 'AssistantMessage.liveFollow', 'scrollHeight')
    panel.scrollTop = scrollHeight
  }, [isStreaming, reasoningDisplayMode, livePanelExpanded, liveReasoningText])

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

      {/* Reasoning Panel: 统一 DOM 结构，live/summary 内容共享容器，避免 mount/unmount 导致 layout shift */}
      {hasReasoning && (
        <div className="message-thinking">
          <div
            className="message-thinking-header"
            onClick={handleHeaderClick}
            style={!isStreaming ? { cursor: 'pointer' } : undefined}
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
            {!isStreaming && (
              <span className="message-thinking-arrow">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {reasoningDisplayMode === 'live' ? (livePanelExpanded ? (
                    <path d="M3 5L6 8L9 5" />
                  ) : (
                    <path d="M5 3L8 6L5 9" />
                  )) : (summaryExpandedEffective ? (
                    <path d="M3 5L6 8L9 5" />
                  ) : (
                    <path d="M5 3L8 6L5 9" />
                  ))}
                </svg>
              </span>
            )}
          </div>

          <div className="reasoning-body">
            {/* Live Reasoning Panel: live 模式下始终挂载（保持 DOM 生命周期 / scrollTop），折叠用 display:none */}
            {reasoningDisplayMode === 'live' && (
              <div
                className="message-thinking-content message-thinking-live-panel"
                style={livePanelExpanded ? undefined : { display: 'none' }}
              >
                <div
                  className="message-thinking-live-scroll"
                  ref={reasoningPanelRef}
                  onScroll={handleReasoningPanelScroll}
                >{liveReasoningText}</div>
                {showReasoningScrollBtn && (
                  <button
                    className="message-thinking-scroll-btn"
                    onClick={scrollReasoningToBottom}
                    aria-label="查看最新思考"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 3v10" />
                      <path d="M3 8l5 5 5-5" />
                    </svg>
                    <span>最新思考</span>
                  </button>
                )}
              </div>
            )}

            {/* Codex Summary Panel: 仅在 summary 模式 + 有摘要 + 展开时挂载 Markdown，折叠时不挂载 */}
            {reasoningDisplayMode === 'summary' && hasSummary && summaryExpandedEffective && (
              <div className="message-thinking-content">
                <div className="message-thinking-summary-title">推理摘要</div>
                <div className="message-thinking-summary-content">
                  {reasoningMeta && (
                    <MarkdownRenderer>{
                      isCodex
                        ? reasoningMeta.summary.map((s) => `- ${s}`).join('\n')
                        : reasoningMeta.summary.join('\n\n')
                    }</MarkdownRenderer>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 搜索活动：稳定容器，running/completed/error 共用 StatusRow 节点，不 mount/unmount */}
      {(showWebSearch || (isStreaming ? webSearch.error : message.webSearchError) || hasSearchResults) && (
        <div className="message-search-activity">
          <div
            className={`message-search-status${showWebSearch ? ' message-search-status--running' : (isStreaming ? webSearch.error : message.webSearchError) ? ' message-search-status--error' : ' message-search-status--done'}`}
            onClick={hasSearchResults ? () => setSearchExpanded(!searchExpanded) : undefined}
            style={hasSearchResults ? { cursor: 'pointer' } : undefined}
          >
            <svg className="message-search-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {showWebSearch ? (
                <>
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </>
              ) : (isStreaming ? webSearch.error : message.webSearchError) ? (
                <>
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </>
              ) : (
                <>
                  <polyline points="9 11 12 14 22 4"/>
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </>
              )}
            </svg>
            <span className="message-search-status-text">
              {showWebSearch
                ? (webSearch.toolName === 'openchat_web_fetch'
                  ? (webSearch.query ? `正在读取：${webSearch.query}` : '正在读取网页...')
                  : (webSearch.query ? `正在搜索：${webSearch.query}` : '正在搜索网页...'))
                : (isStreaming ? webSearch.error : message.webSearchError)
                  ? `搜索失败：${isStreaming ? webSearch.error : message.webSearchError}`
                  : `搜索到 ${searchResults.length} 个参考页面`
              }
            </span>
            {hasSearchResults && (
              <span className="message-search-status-arrow">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {searchExpanded ? (
                    <path d="M3 5L6 8L9 5" />
                  ) : (
                    <path d="M5 3L8 6L5 9" />
                  )}
                </svg>
              </span>
            )}
          </div>
          {hasSearchResults && searchExpanded && (
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
          <MarkdownRenderer messageId={message.id} settled={isMessageSettled}>{rawContent}</MarkdownRenderer>
        ) : isStreaming ? (
          <div>...</div>
        ) : null}
      </div>

      {/* 图片生成结果：复用与用户上传图片相同的网格 + Lightbox */}
      {generatedImages.length > 0 && (
        <div className={`message-image-grid message-image-grid--${generatedImages.length === 1 ? 'single' : 'multi'}`}>
          {generatedImages.map((att) => (
            <button
              key={att.id}
              type="button"
              className="message-image-cell message-image-cell--generated"
              onClick={() => openLightbox(att)}
              aria-label={`查看生成图片 ${att.fileName}`}
            >
              <img
                src={thumbnailUrl(att.id)}
                alt={att.fileName}
                width={att.width > 0 ? att.width : undefined}
                height={att.height > 0 ? att.height : undefined}
                loading="lazy"
                decoding="async"
              />
            </button>
          ))}
        </div>
      )}

      {/* 图片生成进行中占位骨架：保持布局稳定，避免结果到达时消息列表跳动。
          「图片逐渐生成」的动画语义，而非通用 loading spinner。 */}
      {generatedImages.length === 0 && isImageGenerating && (
        <div className="message-image-placeholder" role="status" aria-label="图片生成中">
          <div className="message-image-gen-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <defs>
                {/* 静态 frame clipPath：仅防止 sun / mountain / scan 溢出图片框，自身不动画 */}
                <clipPath id={`image-gen-${message.id}-frame`}>
                  <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="1.6" />
                </clipPath>
                <linearGradient id={`image-gen-${message.id}-sweep`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" className="image-gen-sweep-stop" />
                  <stop offset="50%" className="image-gen-sweep-stop image-gen-sweep-stop--mid" />
                  <stop offset="100%" className="image-gen-sweep-stop" />
                </linearGradient>
              </defs>
              {/* 内部图像内容：太阳 / 山峰 / 高光，全部限制在图片框内 */}
              <g clipPath={`url(#image-gen-${message.id}-frame)`}>
                <circle className="image-gen-sun" cx="8.5" cy="8.5" r="1.5" />
                {/* 山峰用 stroke-dashoffset 沿 path 绘制；pathLength 归一化后 dash 参数与坐标无关 */}
                <path className="image-gen-landscape" pathLength="1" d="M21 15l-5-5L5 21" />
                <rect className="image-gen-scan" x="3.4" y="3.4" width="6.4" height="17.2" fill={`url(#image-gen-${message.id}-sweep)`} />
              </g>
              {/* frame stroke 在裁剪内容之上，始终保持完整 */}
              <rect className="image-gen-frame" x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <span className="image-gen-sparkle image-gen-sparkle--lg" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0L14.4 9.6L24 12L14.4 14.4L12 24L9.6 14.4L0 12L9.6 9.6Z" />
              </svg>
            </span>
            <span className="image-gen-sparkle image-gen-sparkle--sm" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0L14.4 9.6L24 12L14.4 14.4L12 24L9.6 14.4L0 12L9.6 9.6Z" />
              </svg>
            </span>
          </div>
          <div className="message-image-placeholder-text">
            正在生成图片
            <span className="image-gen-dots" aria-hidden="true">
              <span className="image-gen-dot" />
              <span className="image-gen-dot" />
              <span className="image-gen-dot" />
            </span>
          </div>
        </div>
      )}
      {statusBadge && <div className="message-status">{statusBadge}</div>}
      {message.errorCode && (
        <div className="message-error">
          {/* 图片生成错误码（IMAGE_GENERATION_*）是内部标识，对用户无意义；
              其 errorMessage 已是面向用户的具体原因，直接展示。 */}
          {message.errorCode.startsWith('IMAGE_GENERATION_')
            ? message.errorMessage
            : `${message.errorCode}: ${message.errorMessage}`}
        </div>
      )}
    </div>
  )
})