import React, { useState, useEffect, useRef } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useProviderStore } from '../../stores/providerStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { ModelSelector } from './ModelSelector'
import { ProviderSelector } from './ProviderSelector'
import { ReasoningSelector } from './ReasoningSelector'
import { WebSearchToggle } from './WebSearchToggle'
import { CodexSearchModeSelector } from './CodexSearchModeSelector'
import { SearchEngineSelector } from './SearchEngineSelector'
import { MessageInput } from './MessageInput'
import { SendButton } from './SendButton'
import { AttachButton } from './AttachButton'
import { AttachmentStrip } from './AttachmentStrip'
import { useCodexUsageStore, isCodexExhausted } from '../../stores/codexUsageStore'
import type { MessageAttachment } from '../../../shared/types/conversation'
import { MAX_IMAGES_PER_MESSAGE } from '../../../shared/constants'
import { importFiles, imageFilesFromDataTransfer } from '../../packages/attachmentDraftIO'
import { modelSupportsImage, historyHasImage } from '../../packages/imageCapability'
import { toPreviewImage } from '../../packages/conversationPreviewImages'
import { resolveConversationBinding, bindingBlockedMessage } from '../../../shared/conversation/capabilities'
import { ComposerNotice, type ComposerNoticeData } from './ComposerNotice'

function formatResetTime(resetAt: number): string {
  const d = new Date(resetAt * 1000)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

export function Composer() {
  const [text, setText] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<MessageAttachment[]>([])
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [importErrors, setImportErrors] = useState<Array<{ fileName: string; message: string }>>([])
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const activeMessages = useConversationStore((s) => s.activeMessages)
  const setStatus = useChatStreamStore((s) => s.setStatus)
  const setActiveAssistantMessage = useChatStreamStore((s) => s.setActiveAssistantMessage)
  const setError = useChatStreamStore((s) => s.setError)
  const error = useChatStreamStore((s) => s.error)
  const status = useChatStreamStore((s) => s.status)
  const streamingConversationId = useChatStreamStore((s) => s.streamingConversationId)
  const usage = useCodexUsageStore((s) => s.usage)
  const exhausted = isCodexExhausted(usage)
  // 使用自定义服务时，忽略 Codex 额度限制
  const isCustomProvider = !!activeConversation?.providerConfigId
  const isExhausted = exhausted && !isCustomProvider
  const models = useModelStore((s) => s.models)
  const providers = useProviderStore((s) => s.providers)
  const openLightbox = useUiStore((s) => s.openLightbox)

  // 内存缓存当前会话的草稿，避免 IPC 往返延迟
  const draftRef = useRef<string>('')
  // 追踪上一次的 activeConversationId，用于切换时持久化旧草稿
  const prevConversationIdRef = useRef<string | null>(null)
  // 防抖写库 timer
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 防抖合并导入错误提示
  const importErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)

  const currentConversation = activeConversation ?? null

  // 统一 binding 解析：会话类型权威（conversation.type），Provider 协议仅作兼容性约束。
  const binding = currentConversation
    ? resolveConversationBinding({
        conversationType: currentConversation.type,
        providerConfigId: currentConversation.providerConfigId,
        modelId: currentConversation.defaultModelId,
        providers,
      })
    : null

  // binding 失效：provider_missing / provider_incompatible / model_missing 才是 blocking。
  // unconfigured 表示「未绑定 → 走 ChatGPT Codex 默认路径」，可正常发送，不阻止、不提示。
  const bindingBlocked = !!binding && binding.status !== 'valid' && binding.status !== 'unconfigured'

  // 单一 notice slot：同一时刻只渲染一条，按优先级取最高：
  // 1) runtime error（网络 / API / IPC 等，可恢复的配置问题不应盖过它）
  // 2) blocking binding warning（可恢复的配置问题）
  // 注意：binding warning 不会被丢弃 —— runtime error 清除后自动重新显示。
  const composerNotice: ComposerNoticeData | null = error
    ? { variant: 'error', message: error }
    : bindingBlocked && binding && currentConversation
      ? { variant: 'warning', message: bindingBlockedMessage(binding.status, currentConversation.type) }
      : null

  // 切换会话时，先持久化旧草稿，再加载新草稿与新会话的未发送图片
  useEffect(() => {
    const prevId = prevConversationIdRef.current
    const newId = activeConversationId ?? null

    // 持久化旧会话的草稿（立即 flush，不防抖）
    if (prevId && prevId !== newId) {
      const oldDraft = draftRef.current
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      if (oldDraft) {
        window.openchat.settings.setDraft(prevId, oldDraft)
      }
    }

    prevConversationIdRef.current = newId

    if (!newId) {
      setText('')
      draftRef.current = ''
      setDraftAttachments([])
      return
    }

    // 加载新会话的草稿
    window.openchat.settings.getDraft(newId).then((saved) => {
      // 防止竞态：确保加载时还是这个会话
      if (useConversationStore.getState().activeConversationId === newId) {
        const draft = saved ?? ''
        setText(draft)
        draftRef.current = draft
      }
    })
    // 加载新会话的未发送附件（Main 侧持久化，崩溃/重启后仍可恢复）
    window.openchat.attachments.listDrafts(newId, 'chat_input').then((atts) => {
      if (useConversationStore.getState().activeConversationId === newId) {
        setDraftAttachments(atts)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId])

  // 每次 text 变化时同步到 draftRef 并防抖持久化
  useEffect(() => {
    draftRef.current = text
    if (!activeConversationId) return

    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      window.openchat.settings.setDraft(activeConversationId, text)
    }, 500)
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [text, activeConversationId])

  // 错误提示自动消失
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(timer)
  }, [error, setError])

  useEffect(() => () => {
    if (importErrorTimerRef.current) clearTimeout(importErrorTimerRef.current)
  }, [])

  const isStreamingForCurrent = (status === 'streaming' || status === 'starting') && streamingConversationId === activeConversationId

  const remainingSlots = MAX_IMAGES_PER_MESSAGE - draftAttachments.length

  // 导入图片到草稿（文件选择 / 拖拽 / 粘贴共用）
  const handleImport = async (files: File[]) => {
    if (files.length === 0) return
    if (!currentConversation) return
    setImporting(true)
    try {
      const { attachments, errors } = await importFiles(files, activeConversationId, remainingSlots, 'chat_input', MAX_IMAGES_PER_MESSAGE)
      if (attachments.length > 0) {
        setDraftAttachments((prev) => [...prev, ...attachments])
      }
      if (errors.length > 0) {
        setImportErrors(errors)
        if (importErrorTimerRef.current) clearTimeout(importErrorTimerRef.current)
        importErrorTimerRef.current = setTimeout(() => setImportErrors([]), 4000)
      }
    } finally {
      setImporting(false)
    }
  }

  const handlePickImages = async () => {
    if (!currentConversation || importing) return
    const result = await window.openchat.attachments.pick(activeConversationId)
    if (result.attachments.length > 0) {
      setDraftAttachments((prev) => [...prev, ...result.attachments])
    }
    if (result.errors.length > 0) {
      setImportErrors(result.errors)
      if (importErrorTimerRef.current) clearTimeout(importErrorTimerRef.current)
      importErrorTimerRef.current = setTimeout(() => setImportErrors([]), 4000)
    }
  }

  const handleRemoveDraft = (attachmentId: string) => {
    setDraftAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
    window.openchat.attachments.delete(attachmentId)
  }

  // 拖拽：当前窗口没有 webUtils，renderer 只能把 File 转成字节经 IPC 送 Main。
  // 因此这里不读取 file.path，统一走 prepareFromBytes（类型由 Main 按 magic bytes 校验）。
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // 只有真正离开 composer 区域才关闭遮罩（避免子元素抖动）
    if (e.currentTarget === e.target) setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (isStreamingForCurrent) return
    const files = imageFilesFromDataTransfer(e.dataTransfer)
    void handleImport(files)
  }

  // 拖拽经过窗口非输入区（拖图片悬停时防止浏览器默认行为），
  // 并在拖出窗口/结束时收起遮罩，避免遮罩残留。
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const prevent = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const reset = () => setDragOver(false)
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])

  // 发送前能力校验：待发送图片 + 历史需 replay 的图片有一项存在
  // 且所选模型不支持图片输入 → 阻止发送并保留草稿。
  const requiresImage = draftAttachments.length > 0 || historyHasImage(activeMessages)
  const supportsImage = modelSupportsImage(currentConversation, models, providers)
  // 图片能力不满足：有图片上下文但所选模型不支持图片输入 → 禁用发送。
  const imageCapabilityBlocked = requiresImage && !supportsImage

  const handleSend = async () => {
    console.log('[Composer] handleSend entry activeConversationId=%s text=%s streamingStatus=%s currentError=%s attachments=%d', activeConversation?.id ?? 'null', text.trim() ? `"${text.trim().slice(0, 30)}"` : '(empty)', useChatStreamStore.getState().status, useChatStreamStore.getState().error, draftAttachments.length)
    if (!activeConversation) { console.log('[Composer] handleSend SKIP: no conversation'); return }
    if (!text.trim() && draftAttachments.length === 0) { console.log('[Composer] handleSend SKIP: empty text and no attachments'); return }
    if (isExhausted) { console.log('[Composer] handleSend SKIP: exhausted'); return }

    // 会话类型权威：chat 会话的 Provider binding 失效时，先于 IPC 提示用户重新选择。
    // 绝不把「原供应商已不再支持聊天」误报为「会话已锁定为图片生成」。
    // 该失效文案已由统一 notice slot 常驻渲染，这里只拦截发送，
    // 不写入 transient error，避免同一提示出现两份。
    if (bindingBlocked) {
      console.log('[Composer] handleSend BLOCKED: binding %s', binding?.status)
      return
    }

    // 发送前图片能力拦截（与 Main 侧门禁一致，先于 IPC 提示用户）
    if (imageCapabilityBlocked) {
      setError('当前话题包含图片上下文，所选模型不支持图片输入。请选择支持图片的模型，或开始新话题。')
      console.log('[Composer] handleSend BLOCKED: image required but model unsupported')
      return
    }

    if (draftAttachments.length > MAX_IMAGES_PER_MESSAGE) {
      setError(`单条消息最多支持 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
      return
    }

    // 清除上一个请求的残留错误
    setError(null)
    useChatStreamStore.getState().setStreamError(null, null)

    const conversationId = activeConversation.id
    const messageText = text.trim()

    // 已有生成在进行中，提前拦截，不清空用户输入
    const currentStreamingId = useChatStreamStore.getState().streamingConversationId
    if (currentStreamingId) {
      setError('已有正在进行的生成')
      return
    }

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    draftRef.current = ''
    setText('')
    window.openchat.settings.deleteDraft(conversationId)
    const sentAttachments = draftAttachments
    const attachmentIds = sentAttachments.map((a) => a.id)
    setDraftAttachments([])
    setStatus('starting')
    useChatStreamStore.getState().setStreamingConversationId(conversationId)
    useChatStreamStore.getState().setReasoningDisplayMode('none')

    try {
      const result = await window.openchat.chat.send(conversationId, messageText, attachmentIds)
      const streamState = useChatStreamStore.getState()
      console.log('[Composer] chat.send resolved, status=%s streamingId=%s pendingError=%s', streamState.status, streamState.streamingConversationId, streamState.errorCode ?? 'null')

      if (result) {
        // 从 Provider 返回的 reasoningDisplayMode 锁定整条 turn，之后不再变化
        useChatStreamStore.getState().setReasoningDisplayMode(result.reasoningDisplayMode)

        // 若错误已在 await 期间到达（同步 IPC 回调优先于 microtask），
        // 在追加前就把错误应用到 assistant 消息，确保一次性渲染 + 正确滚动
        const assistantMsg = (streamState.errorCode || streamState.errorMessage)
          ? {
              ...result.assistantMessage,
              status: 'failed' as const,
              errorCode: streamState.errorCode,
              errorMessage: streamState.errorMessage,
            }
          : result.assistantMessage

        useConversationStore.getState().setActiveMessages([
          ...useConversationStore.getState().activeMessages,
          result.userMessage,
          assistantMsg,
        ])
        setActiveAssistantMessage(assistantMsg.id)
        // 记录本轮 live stream 的稳定身份：Main 返回的真实 assistant message id。
        // 之后所有 live buffer 归属都以它为唯一依据，直到 turn-completed / error / stop 才清除。
        useChatStreamStore.getState().setStreamingAssistantMessageId(assistantMsg.id)
      }

      if (streamState.errorCode || streamState.errorMessage) {
        useChatStreamStore.getState().setStreamError(null, null)
        return
      }

      // 无错误，正常进入 streaming
      setStatus('streaming')

      // 只刷新侧边栏列表（会话标题可能已更新）
      // 注意：流式期间不再 conversations.get 全量刷新，避免旧会话大消息列表
      // 触发 activeMessages 整体替换导致文字抖动与增量内容重复
      const list = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(list)
    } catch (err) {
      console.error('[Composer] Send failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      // Main 侧能力门禁拒绝（图片上下文 + 不支持图片的模型）时恢复草稿，避免输入丢失。
      // IPC 只透传 message（不含 code），因此按错误文案匹配；门禁在消息创建之前触发，
      // 因此附件仍是未绑定的草稿，可安全放回草稿条。
      if (message.includes('不支持图片输入')) {
        if (sentAttachments.length > 0) setDraftAttachments(sentAttachments)
        if (!draftRef.current) setText(messageText)
      }
      console.log('[Composer] catch block: setting error, status=%s streamingId=%s', useChatStreamStore.getState().status, useChatStreamStore.getState().streamingConversationId)
      setError(message)
      setStatus('idle')
      setActiveAssistantMessage(null)
      useChatStreamStore.getState().setStreamingConversationId(null)
      useChatStreamStore.getState().setStreamingAssistantMessageId(null)
    }
  }

  const handleStop = async () => {
    setStatus('stopping')
    setActiveAssistantMessage(null)
    useChatStreamStore.getState().setStreamingConversationId(null)
    useChatStreamStore.getState().setStreamingAssistantMessageId(null)
    await window.openchat.chat.interrupt()

    // 刷新消息列表以获取更新后的状态（stopped）
    const conversationId = activeConversation?.id
    if (conversationId) {
      const data = await window.openchat.conversations.get(conversationId)
      if (data) {
        useConversationStore.getState().setActiveConversation(data.conversation)
        useConversationStore.getState().setActiveMessages(data.messages)
        useConversationStore.getState().setActiveSegments(data.segments)
      }
      // 刷新侧边栏列表
      const list = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(list)
    }

    setStatus('idle')
  }

  return (
    <div
      className="composer"
      ref={composerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="composer-inner">
        {isExhausted && (
          <div className="composer-usage-exhausted">
            Codex 额度已用尽
            {usage.resetAt ? `，将于 ${formatResetTime(usage.resetAt)} 恢复。` : '。'}
          </div>
        )}
        {/* 统一提示条：同一时刻只渲染一个 notice slot（runtime error 优先于 binding warning） */}
        {composerNotice && (
          <ComposerNotice variant={composerNotice.variant}>
            {composerNotice.message}
          </ComposerNotice>
        )}
        <AttachmentStrip
          attachments={draftAttachments}
          disabled={isStreamingForCurrent || importing}
          onRemove={handleRemoveDraft}
          onPreview={(att) => openLightbox(att.id, toPreviewImage(att))}
        />
        {importErrors.length > 0 && (
          <div className="composer-attachment-errors">
            {importErrors.map((e, i) => (
              <div key={i}>{e.fileName}：{e.message}</div>
            ))}
          </div>
        )}
        <MessageInput
          text={text}
          onChange={setText}
          onSend={handleSend}
          onStop={handleStop}
          onPasteImages={handleImport}
          hasDraftAttachments={draftAttachments.length > 0}
          sendBlocked={bindingBlocked || imageCapabilityBlocked}
        />
        <div className="composer-controls">
          <AttachButton onClick={handlePickImages} disabled={isStreamingForCurrent || importing || !currentConversation} />
          <ProviderSelector />
          <ModelSelector />
          <ReasoningSelector />
          <WebSearchToggle />
          <CodexSearchModeSelector />
          <SearchEngineSelector />
          <div className="composer-spacer" />
          <SendButton
            onSend={handleSend}
            onStop={handleStop}
            hasText={(text.trim().length > 0 || draftAttachments.length > 0) && !isExhausted}
            blockedByBinding={bindingBlocked}
            blockedByImageCapability={imageCapabilityBlocked}
          />
        </div>
      </div>
      {dragOver && !isStreamingForCurrent && (
        <div className="composer-drag-overlay">松开以添加图片</div>
      )}
    </div>
  )
}