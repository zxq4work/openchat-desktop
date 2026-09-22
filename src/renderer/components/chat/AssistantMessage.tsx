import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useContext } from 'react'
import type { Message } from '../../../shared/types/conversation'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useModelStore } from '../../stores/modelStore'
import { useImageGenerationStore } from '../../stores/imageGenerationStore'
import { useUiStore } from '../../stores/uiStore'
import { imageAttachments, thumbnailUrl } from '../../packages/attachmentUrl'
import { parseRequestedDims, fitSlot, IMAGE_SLOT_MAX } from '../../packages/imageSlot'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { ScrollContainerContext } from './ScrollContainerContext'
import { probeLayoutRead } from '../../packages/layoutReadDiag'
import { openMessageContextMenu, openImageContextMenu } from '../../packages/messageMenu'

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
  const imageGenPendingAssistantId = useImageGenerationStore((s) => s.pendingAssistantMessageId)
  const imageGenPendingSize = useImageGenerationStore((s) => s.pendingSize)
  // 占位骨架的「被跟踪」判定：本消息是当前 pending 的目标。
  // pendingAssistantMessageId 由 setStarted 写入、由 clearPending（像素就绪）/setFailed/reset 清除。
  // 关键：不把可见性直接绑 activeAssistantMessageId，否则 setCompleted 会立刻卸载占位，
  // 在异步 reload 提交前露出一帧「这一条消息什么都没了」的空白 → 抖动。
  // 也不绑「本消息是否已 completed 且未 ready」——那会让历史会话图片误套生成占位。
  const isHandoffTracked = imageGenPendingAssistantId === message.id
  // 仍在网络生成中（active 与 pending 同源写入，setCompleted 仅清 active）。
  const isActiveGenerating = imageGenActiveAssistantId === message.id
  // 结果图片的「像素已就绪」状态（按 attachment.id 隔离，连续生成互不干扰）。
  // generation_output 附件进入 activeMessages 只代表元数据就绪，<img> 仍需经
  // openchat-attachment protocol → 文件读取 → decode → paint。
  // 在此之前保持占位覆盖层可见，避免「有尺寸但未 decode 的空 img box」白帧。
  const [readyAttachmentIds, setReadyAttachmentIds] = useState<Set<string>>(() => new Set())
  const markVisualReady = useCallback((attachmentId: string) => {
    setReadyAttachmentIds((prev) => {
      if (prev.has(attachmentId)) return prev
      const next = new Set(prev)
      next.add(attachmentId)
      return next
    })
  }, [])

  // 本地图片展示失败（thumbnail protocol / 文件读取 / decode 失败）。
  // 这是 Renderer 的图片加载状态，不是 Provider generation 状态：
  // 绝不写入 imageGenerationStore，也不改 image_generations DB（生成本身已成功落盘）。
  // 有了它，onError 才能结束 handoff，避免占位永久停在「正在生成图片」。
  const [failedVisualAttachmentIds, setFailedVisualAttachmentIds] = useState<Set<string>>(() => new Set())
  const markVisualFailed = useCallback((attachmentId: string) => {
    setFailedVisualAttachmentIds((prev) => {
      if (prev.has(attachmentId)) return prev
      const next = new Set(prev)
      next.add(attachmentId)
      return next
    })
  }, [])

  // 单图结果（正常 n=1 契约）。slot 高度优先取真实 attachment.width/height；
  // 附件未到时用请求比例预留，避免 decode 阶段再次改变槽位高度。
  // 多图（第三方 Provider 无视 n=1 返回多个 data item 时 Main 会全部落盘）走原 multi 网格。
  const singleImage = generatedImages.length === 1 ? generatedImages[0] : null
  const resultSlot = (() => {
    if (singleImage && singleImage.width > 0 && singleImage.height > 0) {
      return fitSlot(singleImage.width, singleImage.height)
    }
    // 附件未到：占位阶段按请求比例预留（请求 1024×1536 → 213×320，而非固定 320×320）
    const req = parseRequestedDims(imageGenPendingSize)
    return req ? fitSlot(req.width, req.height) : { width: IMAGE_SLOT_MAX, height: IMAGE_SLOT_MAX }
  })()

  // 占位覆盖层：仅在本消息是本轮生成目标、且单图结果尚未就绪时显示。
  // - 无结果（生成本身进行中）；或
  // - 单图元数据已到但像素尚未就绪。
  // 像素就绪 / 本地加载失败后 clearPending 置空本消息 pending → 覆盖层自动卸载。
  // 多图走原网格、不再叠加占位；历史会话图片从不被跟踪，不会误显示生成占位。
  const showPlaceholderOverlay =
    isHandoffTracked &&
    generatedImages.length <= 1 &&
    !(singleImage !== null && failedVisualAttachmentIds.has(singleImage.id))
  // settling：单图元数据已到、仅等本地 decode。此时停止占位内部循环动画，
  // 避免「模型已完成又开始重绘」，冻结在最后完整状态。
  const settling = showPlaceholderOverlay && !isActiveGenerating && singleImage !== null

  // 占位 → 结果的 handoff 结束条件：结果已就绪（ready）或本地加载失败（failed）。
  // 失败也算「结束」，否则 onError 会让 pending 永久卡住。
  // 多图：原网格自带固定 cell 尺寸、无白帧，结果一到即结束 handoff。
  const handoffSettled =
    generatedImages.length > 1 ||
    (singleImage !== null &&
      (readyAttachmentIds.has(singleImage.id) || failedVisualAttachmentIds.has(singleImage.id)))
  // 结果图片像素就绪（或加载失败）后，才在 paint 前清空 pending 标记。
  // 绝不在 attachment 出现的瞬间就清 —— 那会让占位提前卸载，露出未 decode 的白帧。
  const clearPendingGeneration = useImageGenerationStore((s) => s.clearPending)
  useLayoutEffect(() => {
    if (isHandoffTracked && handoffSettled) {
      clearPendingGeneration(message.id)
    }
  }, [isHandoffTracked, handoffSettled, message.id, clearPendingGeneration])

  // 缓存命中的兜底：<img> 若在挂载前已完整缓存，onLoad 可能不触发。
  // 挂载后在 paint 前用 img.complete + naturalWidth 判定，直接置为 ready。
  // 只把 naturalWidth>0 视为 ready；不用 complete+naturalWidth===0 判失败（避免首帧误判），
  // 失败一律以 onError 为准。
  const resultImgRef = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    const img = resultImgRef.current
    if (img && img.complete && img.naturalWidth > 0 && singleImage) {
      markVisualReady(singleImage.id)
    }
  }, [singleImage, markVisualReady])
  const [summaryExpanded, setSummaryExpanded] = useState(
    // 当前 turn 的消息（非 completed）默认展开 reasoning 面板，避免 completion 时
    // summaryExpanded 从 false 切到 true 导致 DOM 卸载再挂载，scrollTop 归零。
    () => message.status !== 'completed'
  )
  const [searchExpanded, setSearchExpanded] = useState(false)
  const reasoningPanelRef = useRef<HTMLDivElement>(null)
  // 消息根节点：右键菜单据此限定「属于本消息的选区」，避免复制到别的消息。
  const rootRef = useRef<HTMLDivElement>(null)

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
    <div
      className="message assistant-message"
      data-message-id={message.id}
      ref={rootRef}
      onContextMenu={(e) => openMessageContextMenu(e, rootRef.current as HTMLElement, message.content)}
    >
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

      {/* 单图结果 slot：最终图片与占位覆盖层叠放于同一槽位。
          槽位高度只由这一处决定（占位为绝对定位覆盖层，不贡献第二份布局高度），
          因此图片 decode 阶段 scrollHeight 稳定，不会因两套 block 交替而闪动。
          渲染条件含「尚未到达附件但正在生成」——此时 slot 仅承载占位覆盖层，
          用请求比例预留高度（见 resultSlot）；绝不能因 generatedImages.length===0 就整块不渲染，
          否则生成期间看不到任何占位。
          多图（第三方 Provider 返回多张）走下方独立网格，不套用单图 slot。 */}
      {(generatedImages.length === 1 || showPlaceholderOverlay) && (() => {
        const att = generatedImages.length === 1 ? generatedImages[0] : null
        const visualFailed = att !== null && failedVisualAttachmentIds.has(att.id)
        return (
          <div
            className="generation-image-slot"
            style={{ width: resultSlot.width, height: resultSlot.height }}
          >
            {att !== null && !visualFailed && (
              <div className="message-image-grid message-image-grid--single">
                <button
                  type="button"
                  className="message-image-cell message-image-cell--generated"
                  onClick={() => openLightbox(att.id)}
                  onContextMenu={(e) => openImageContextMenu(e, att.id, message.content)}
                  aria-label={`查看生成图片 ${att.fileName}`}
                >
                  <img
                    ref={resultImgRef}
                    className={`generation-result-image${readyAttachmentIds.has(att.id) ? ' is-ready' : ''}`}
                    src={thumbnailUrl(att.id)}
                    alt={att.fileName}
                    width={att.width > 0 ? att.width : undefined}
                    height={att.height > 0 ? att.height : undefined}
                    loading="lazy"
                    decoding="async"
                    onLoad={() => markVisualReady(att.id)}
                    onError={() => markVisualFailed(att.id)}
                  />
                </button>
              </div>
            )}

            {/* 本地图片展示失败：gen 已成功，仅 thumbnail 读取失败。轻量内联提示，保持 slot 高度。
                与 Provider generation failed 的 .message-error 明确区分。 */}
            {visualFailed && (
              <div className="generation-image-load-error" role="status" aria-label="图片加载失败">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="1.6" />
                  <path d="M21 15l-5-5L5 21" />
                  <line x1="3" y1="3" x2="21" y2="21" />
                </svg>
                <span>图片加载失败</span>
              </div>
            )}

            {/* 占位覆盖层：生成本轮进行中 / 单图元数据已到但像素未就绪时显示。
                与最终图片叠放于同一 slot，绝不贡献第二份高度；像素就绪或加载失败后卸载。 */}
            {showPlaceholderOverlay && (
              <div
                className={`message-image-placeholder message-image-placeholder--overlay${settling ? ' is-settling' : ''}`}
                role="status"
                aria-label="图片生成中"
              >
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
          </div>
        )
      })()}

      {/* 多图结果（第三方 Provider 无视 n=1 返回多张时）：沿用原 multi 网格，
          每张独立 ready / error，不做生成占位交接（fixed cell 尺寸，无白帧）。
          单图加载失败同样在此显示轻量提示。 */}
      {generatedImages.length > 1 && (
        <div className="message-image-grid message-image-grid--multi">
          {generatedImages.map((att) => (
            <button
              key={att.id}
              type="button"
              className="message-image-cell message-image-cell--generated"
              onClick={() => openLightbox(att.id)}
              onContextMenu={(e) => openImageContextMenu(e, att.id, message.content)}
              aria-label={`查看生成图片 ${att.fileName}`}
            >
              {failedVisualAttachmentIds.has(att.id) ? (
                <span className="generation-image-load-error generation-image-load-error--cell" role="status" aria-label="图片加载失败">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="9" cy="9" r="1.6" />
                    <path d="M21 15l-5-5L5 21" />
                    <line x1="3" y1="3" x2="21" y2="21" />
                  </svg>
                </span>
              ) : (
                <img
                  className={`generation-result-image${readyAttachmentIds.has(att.id) ? ' is-ready' : ''}`}
                  src={thumbnailUrl(att.id)}
                  alt={att.fileName}
                  width={att.width > 0 ? att.width : undefined}
                  height={att.height > 0 ? att.height : undefined}
                  loading="lazy"
                  decoding="async"
                  onLoad={() => markVisualReady(att.id)}
                  onError={() => markVisualFailed(att.id)}
                />
              )}
            </button>
          ))}
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