import React, { useState, useEffect, useRef } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useImageGenerationStore } from '../../stores/imageGenerationStore'
import { useProviderStore } from '../../stores/providerStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { useUiStore } from '../../stores/uiStore'
import { Dropdown } from '../Dropdown'
import { AttachButton } from './AttachButton'
import { AttachmentStrip } from './AttachmentStrip'
import { buildParamOptions, isValueAllowed, PARAM_DEFAULT_VALUE, profileSupportsImageToImage, maxInputImagesForProfile } from '../../packages/imageGenerationParams'
import { cleanIpcErrorMessage } from '../../packages/ipcError'
import { importFiles, imageFilesFromDataTransfer } from '../../packages/attachmentDraftIO'
import type { MessageAttachment } from '../../../shared/types/conversation'

// 图片生成 Composer：Model / Size / Quality / Background / OutputFormat（+ 可选参考图）。
// 全部由 Provider 的 ImageGenerationProfile 驱动：
// - Profile 未启用某参数 → 不显示对应下拉，且请求不发送该字段
// - 「默认」= 不发送（canonical undefined），绝不发送字符串 "auto"
// - 参考图入口仅在 profile.operations.imageToImage.enabled 时显示
// 不含联网搜索、推理等级、系统提示等 Chat 专属能力；
// 参考图是 Generation Reference Image，不是 Chat Image Input（usage=generation_input）。
const CUSTOM_SIZE_VALUE = '__custom__'

export function ImageComposer() {
  const [text, setText] = useState('')
  // 参考图草稿：与 Chat 的 draftAttachments 完全独立（不同 usage，不同加载路径）。
  const [inputAttachments, setInputAttachments] = useState<MessageAttachment[]>([])
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [importErrors, setImportErrors] = useState<Array<{ fileName: string; message: string }>>([])
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const providers = useProviderStore((s) => s.providers)
  const phase = useImageGenerationStore((s) => s.phase)
  const genConversationId = useImageGenerationStore((s) => s.conversationId)
  const setError = useChatStreamStore((s) => s.setError)
  const openLightbox = useUiStore((s) => s.openLightbox)
  // 输入框上方只提示「发送前」可预见的错误：本地校验 + Main 发送前校验拒绝。
  // 这些错误发生在消息创建之前，没有对应的 AssistantMessage 可承载，只能在此提示。
  // 生成过程中的失败（image-generation-failed）已落库到 assistant message 并由
  // AssistantMessage 内联展示，不再在这里重复，避免同一错误两处提示。
  const error = useChatStreamStore((s) => s.error)

  const draftRef = useRef('')
  const prevConversationIdRef = useRef<string | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const importErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)

  const isGeneratingHere = phase === 'generating' && genConversationId === activeConversationId

  // 图片生成服务商：只列出 protocol=image_generations 的 Provider
  const imageProviders = providers.filter((p) => p.protocol === 'image_generations')
  const currentProvider = activeConversation?.providerConfigId
    ? providers.find((p) => p.id === activeConversation.providerConfigId) ?? null
    : null
  const isImageProvider = currentProvider?.protocol === 'image_generations'
  const currentModelId = activeConversation?.defaultModelId ?? null

  // Profile 驱动的参数可见性：未启用的参数不渲染下拉，且不发送该字段。
  const profile = currentProvider?.imageGenerationProfile
  const sizeConfig = profile?.size
  const qualityConfig = profile?.quality
  const backgroundConfig = profile?.background
  const outputFormatConfig = profile?.outputFormat

  // 参考图能力（由 Profile 决定，绝不按供应商名称猜）。
  const supportsImageToImage = profileSupportsImageToImage(profile)
  const maxInputImages = maxInputImagesForProfile(profile)

  const sizeOptions = buildParamOptions(sizeConfig)
  const qualityOptions = buildParamOptions(qualityConfig)
  const backgroundOptions = buildParamOptions(backgroundConfig)
  const outputFormatOptions = buildParamOptions(outputFormatConfig)

  // 自定义尺寸输入状态（仅 size.allowCustom 时可用）
  const [customSizeOpen, setCustomSizeOpen] = useState(false)
  const [customSizeInput, setCustomSizeInput] = useState('')

  // 输出格式：仅当 Profile 启用时生效；不做会话级持久化，「默认」= 不发送字段。
  const [outputFormatValue, setOutputFormatValue] = useState('')

  // 切换 Provider 时重置本组件内的临时选择（输出格式、自定义尺寸输入），
  // 避免上一个 Provider 的遗留值泄漏到不支持的 Provider。
  useEffect(() => {
    setOutputFormatValue('')
    setCustomSizeOpen(false)
    setCustomSizeInput('')
  }, [currentProvider?.id])

  // Profile 收紧（禁用尺寸 / 关闭自定义）时收起自定义尺寸输入，
  // 否则输入框会停留在已不再支持的状态。
  useEffect(() => {
    if (!sizeConfig?.enabled || !sizeConfig.allowCustom) {
      setCustomSizeOpen(false)
      setCustomSizeInput('')
    }
  }, [sizeConfig?.enabled, sizeConfig?.allowCustom])

  // 尺寸下拉选项：预定义值 + 若当前保存的是自定义值（不在预定义列表）则补一项，保证下拉能正确显示它。
  // 关键：仅当该已保存值在当前 Profile 下仍然合法时才补。否则用户收紧 Provider 参数
  // （如删除某个允许值）并保存后，旧值会残留为下拉选项，造成"选项没更新"的错觉。
  const buildSizeOptions = () => {
    if (!sizeConfig?.enabled) return sizeOptions
    const opts = [...sizeOptions]
    const saved = activeConversation?.defaultImageSize ?? ''
    if (saved && isValueAllowed(sizeConfig, saved) && !opts.some((o) => o.value === saved)) {
      opts.push({ value: saved, label: saved })
    }
    if (sizeConfig.allowCustom) {
      opts.push({ value: CUSTOM_SIZE_VALUE, label: '自定义…' })
    }
    return opts
  }

  // 已保存值在当前 Profile 下可能已失效（例如切换 Provider 后）→ UI 回退显示「默认」。
  const sizeValue = isValueAllowed(sizeConfig, activeConversation?.defaultImageSize ?? null)
    ? activeConversation?.defaultImageSize ?? ''
    : ''
  const qualityValue = isValueAllowed(qualityConfig, activeConversation?.defaultImageQuality ?? null)
    ? activeConversation?.defaultImageQuality ?? ''
    : ''
  const backgroundValue = isValueAllowed(backgroundConfig, activeConversation?.defaultImageBackground ?? null)
    ? activeConversation?.defaultImageBackground ?? ''
    : ''

  // 草稿加载 / 切换会话时持久化旧草稿 + 加载参考图草稿
  useEffect(() => {
    const prevId = prevConversationIdRef.current
    const newId = activeConversationId ?? null
    if (prevId && prevId !== newId) {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      if (draftRef.current) window.openchat.settings.setDraft(prevId, draftRef.current)
    }
    prevConversationIdRef.current = newId
    if (!newId) {
      setText('')
      draftRef.current = ''
      setInputAttachments([])
      return
    }
    window.openchat.settings.getDraft(newId).then((saved) => {
      if (useConversationStore.getState().activeConversationId === newId) {
        const draft = saved ?? ''
        setText(draft)
        draftRef.current = draft
      }
    })
    // 参考图草稿：Main 侧持久化，崩溃/重启后可恢复。只取 generation_input，隔离 Chat 图片输入。
    window.openchat.attachments.listDrafts(newId, 'generation_input').then((atts) => {
      if (useConversationStore.getState().activeConversationId === newId) {
        setInputAttachments(atts)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId])

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

  useEffect(() => {
    if (!error) return
    // 发送前校验错误需用户阅读后调整参数，按文案长度自适应停留（下限 3s，上限 10s）。
    const duration = Math.min(10000, Math.max(3000, error.length * 120))
    const timer = setTimeout(() => setError(null), duration)
    return () => clearTimeout(timer)
  }, [error, setError])

  useEffect(() => () => {
    if (importErrorTimerRef.current) clearTimeout(importErrorTimerRef.current)
  }, [])

  // 自动选中第一个图片服务商，避免新会话无 Provider 可用
  useEffect(() => {
    if (!activeConversation) return
    if (isImageProvider) return
    if (imageProviders.length === 0) return
    const first = imageProviders[0]
    void handleProviderChange(first.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, isImageProvider, imageProviders.length])

  const handleProviderChange = async (providerId: string) => {
    if (!activeConversation) return
    const provider = providers.find((p) => p.id === providerId)
    const firstModel = provider?.models?.[0] ?? null
    await window.openchat.conversations.updateProviderConfig(activeConversation.id, providerId)
    if (firstModel) {
      await window.openchat.conversations.updateModel(activeConversation.id, firstModel)
    }
    // Main 侧已按新 Profile 做参数 reconciliation，重新拉取以拿到被清空的默认值
    const data = await window.openchat.conversations.get(activeConversation.id)
    if (data) {
      setActiveConversation(data.conversation)
    } else {
      setActiveConversation({
        ...activeConversation,
        providerConfigId: providerId,
        defaultModelId: firstModel ?? activeConversation.defaultModelId,
      })
    }
    // 切换 Provider 不静默丢弃已选参考图：若新 Provider 不支持图生图，
    // 保留参考图并在发送前通过 setError 提示（见 handleGenerate）。
  }

  const handleModelChange = async (modelId: string) => {
    if (!activeConversation) return
    await window.openchat.conversations.updateModel(activeConversation.id, modelId)
    setActiveConversation({ ...activeConversation, defaultModelId: modelId })
  }

  const handleImageDefaultChange = async (
    field: 'size' | 'quality' | 'background',
    value: string
  ) => {
    if (!activeConversation) return
    // 「默认」→ null（canonical undefined），绝不写入字符串 "auto"。
    const next = {
      defaultImageSize: activeConversation.defaultImageSize,
      defaultImageQuality: activeConversation.defaultImageQuality,
      defaultImageBackground: activeConversation.defaultImageBackground,
    }
    if (field === 'size') next.defaultImageSize = value || null
    if (field === 'quality') next.defaultImageQuality = value || null
    if (field === 'background') next.defaultImageBackground = value || null
    await window.openchat.conversations.updateImageDefaults(
      activeConversation.id,
      next.defaultImageSize,
      next.defaultImageQuality,
      next.defaultImageBackground
    )
    setActiveConversation({ ...activeConversation, ...next })
  }

  // 自定义尺寸：提交时写入会话默认（null 表示「默认」）
  const applyCustomSize = async () => {
    const value = customSizeInput.trim()
    if (!value) return
    if (!/^\d+[xX]\d+$/.test(value)) {
      setError('自定义尺寸格式应为 WIDTHxHEIGHT，例如 1536x1024')
      return
    }
    await handleImageDefaultChange('size', value)
    setCustomSizeOpen(false)
    setCustomSizeInput('')
  }

  // 参考图导入：复用 Chat 的 File → prepareFromBytes 安全导入（magic-byte 校验 / 缩略图 / 去重），
  // 但 usage=generation_input，语义与 Chat 图片输入分开。
  const remainingSlots = maxInputImages - inputAttachments.length

  const handleImport = async (files: File[]) => {
    if (files.length === 0) return
    if (!activeConversation) return
    if (!supportsImageToImage) {
      setError('当前图片供应商不支持参考图生成')
      return
    }
    if (remainingSlots <= 0) {
      setError(`参考图数量已达上限（最多 ${maxInputImages} 张）`)
      return
    }
    setImporting(true)
    try {
      const { attachments, errors } = await importFiles(files, activeConversationId, remainingSlots, 'generation_input', maxInputImages)
      if (attachments.length > 0) {
        setInputAttachments((prev) => [...prev, ...attachments])
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
    if (!activeConversation || importing) return
    if (!supportsImageToImage) {
      setError('当前图片供应商不支持参考图生成')
      return
    }
    if (remainingSlots <= 0) {
      setError(`参考图数量已达上限（最多 ${maxInputImages} 张）`)
      return
    }
    const result = await window.openchat.attachments.pick(activeConversationId, 'generation_input')
    // 超限时只保留前 remainingSlots 张，多余的不进入草稿（避免绕过 Profile 上限）。
    const accepted = result.attachments.slice(0, remainingSlots)
    if (accepted.length > 0) {
      setInputAttachments((prev) => [...prev, ...accepted])
    }
    const errors = [...result.errors]
    if (result.attachments.length > accepted.length) {
      errors.push({ fileName: '', code: 'too_many_images', message: `最多 ${maxInputImages} 张参考图` })
    }
    if (errors.length > 0) {
      setImportErrors(errors)
      if (importErrorTimerRef.current) clearTimeout(importErrorTimerRef.current)
      importErrorTimerRef.current = setTimeout(() => setImportErrors([]), 4000)
    }
  }

  const handleRemoveInput = (attachmentId: string) => {
    setInputAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
    window.openchat.attachments.delete(attachmentId)
  }

  // 拖拽：与 Chat Composer 同策略，统一走字节通道（prepareFromBytes）。
  const handleDragEnter = (e: React.DragEvent) => {
    if (!supportsImageToImage) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (isGeneratingHere || !supportsImageToImage) return
    const files = imageFilesFromDataTransfer(e.dataTransfer)
    void handleImport(files)
  }

  useEffect(() => {
    if (!supportsImageToImage) return
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
  }, [supportsImageToImage])

  // Ctrl/Cmd+V 粘贴图片 → 导入为参考图（纯文本粘贴保持默认行为）。
  const handlePaste = (e: React.ClipboardEvent) => {
    if (isGeneratingHere || !supportsImageToImage) return
    const items = Array.from(e.clipboardData?.items ?? [])
    const files = items
      .filter((it) => it.kind === 'file' && (!it.type || it.type.startsWith('image/')))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length > 0) {
      e.preventDefault()
      void handleImport(files)
    }
  }

  const handleGenerate = async () => {
    if (!activeConversation) return
    const prompt = text.trim()
    if (!prompt) return
    if (!isImageProvider) {
      setError('请先在设置中配置图片生成服务，并为本会话选择该服务。')
      return
    }
    if (!currentModelId) {
      setError('请选择图片模型。')
      return
    }
    if (isGeneratingHere) return
    // 参考图存在但当前 Provider 不支持：阻止发送（不静默丢图、不静默退化为文生图）。
    if (inputAttachments.length > 0 && !supportsImageToImage) {
      setError('当前图片供应商不支持参考图生成。可切换回支持参考图的服务，或删除参考图后再生成。')
      return
    }
    if (inputAttachments.length > maxInputImages) {
      setError(`参考图数量超过上限（最多 ${maxInputImages} 张）`)
      return
    }

    setError(null)
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    draftRef.current = ''
    setText('')
    window.openchat.settings.deleteDraft(activeConversation.id)

    const sentInputs = inputAttachments
    const inputAttachmentIds = sentInputs.map((a) => a.id)
    setInputAttachments([])

    try {
      // 只发送当前 Profile 启用的参数；「默认」用 null 表示 → 省略字段。
      // 未启用的参数绝不携带（否则 Service 会以「不支持参数」拒绝）。
      const result = await window.openchat.imageGeneration.generate(activeConversation.id, prompt, {
        size: sizeConfig?.enabled ? sizeValue || null : null,
        quality: qualityConfig?.enabled ? qualityValue || null : null,
        background: backgroundConfig?.enabled ? backgroundValue || null : null,
        outputFormat: outputFormatConfig?.enabled ? outputFormatValue || null : null,
      }, inputAttachmentIds)
      // 用户/助手消息追加到这里完成；占位骨架由 App.tsx 的
      // image-generation-started 事件驱动（activeAssistantMessageId 匹配）。
      if (result) {
        const messages = useConversationStore.getState().activeMessages
        const alreadyPresent = messages.some((m) => m.id === result.assistantMessage.id)
        if (!alreadyPresent) {
          useConversationStore.getState().setActiveMessages([
            ...messages,
            result.userMessage,
            result.assistantMessage,
          ])
        }
      }
      const list = await window.openchat.conversations.list()
      useConversationStore.getState().setSummaries(list)
    } catch (err) {
      // 剥离 Electron IPC handler 前缀与错误类名，展示可操作的具体原因（如参数校验失败）。
      const message = cleanIpcErrorMessage(err)
      // 发送失败：恢复草稿与参考图，避免输入丢失
      if (!draftRef.current) setText(prompt)
      if (sentInputs.length > 0) setInputAttachments(sentInputs)
      setError(message)
    }
  }

  const handleStop = async () => {
    await window.openchat.imageGeneration.interrupt()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isGeneratingHere) return
      if (text.trim()) void handleGenerate()
    }
    if (e.key === 'Escape' && isGeneratingHere) {
      void handleStop()
    }
  }

  if (!activeConversation) return null

  const modelOptions = (currentProvider?.models ?? []).map((m) => ({ value: m, label: m }))

  // 有参考图时切换占位文案，提示用户描述"如何修改"。
  const placeholder = inputAttachments.length > 0
    ? '描述你想如何修改或融合这些图片…'
    : '描述你想生成的图片…'

  return (
    <div
      className="composer composer--image"
      ref={composerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="composer-inner">
        {error && <div className="composer-error">{error}</div>}

        {imageProviders.length === 0 && (
          <div className="composer-image-hint">
            尚未配置图片生成服务，请在「设置 › 模型服务」中添加协议为 Image Generations 的服务。
          </div>
        )}

        {/* 参考图存在但当前 Provider 不支持：给出明确提示，保留参考图不静默丢弃 */}
        {inputAttachments.length > 0 && !supportsImageToImage && (
          <div className="composer-image-hint composer-image-hint--warn">
            当前图片供应商不支持参考图生成。可切换回支持参考图的服务，或删除参考图。
          </div>
        )}

        <AttachmentStrip
          attachments={inputAttachments}
          disabled={isGeneratingHere || importing}
          onRemove={handleRemoveInput}
          onPreview={openLightbox}
        />

        {importErrors.length > 0 && (
          <div className="composer-attachment-errors">
            {importErrors.map((e, i) => (
              <div key={i}>{e.fileName}{e.fileName ? '：' : ''}{e.message}</div>
            ))}
          </div>
        )}

        <div className="message-input-wrapper">
          <textarea
            ref={textareaRef}
            className="message-input"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={3}
          />
        </div>

        <div className="composer-controls">
          {/* 参考图入口仅在 Profile 允许图生图时显示（OpenAI 官方 /images/generations 不显示） */}
          {supportsImageToImage && (
            <AttachButton
              onClick={handlePickImages}
              disabled={isGeneratingHere || importing || remainingSlots <= 0}
            />
          )}
          <Dropdown
            className="provider-selector"
            value={currentProvider?.id ?? ''}
            placeholder={imageProviders.length ? '选择图片服务' : '无服务'}
            options={imageProviders.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(v) => void handleProviderChange(v)}
            ariaLabel="选择图片生成服务"
          />
          <Dropdown
            className="model-selector"
            value={currentModelId ?? ''}
            placeholder="无模型"
            options={modelOptions}
            onChange={(v) => void handleModelChange(v)}
            ariaLabel="选择图片模型"
          />
          {sizeConfig?.enabled && (
            <>
              <Dropdown
                className="image-size-selector"
                value={customSizeOpen ? CUSTOM_SIZE_VALUE : sizeValue}
                placeholder="尺寸"
                options={buildSizeOptions()}
                onChange={(v) => {
                  if (v === CUSTOM_SIZE_VALUE) {
                    setCustomSizeOpen(true)
                    setCustomSizeInput('')
                    return
                  }
                  setCustomSizeOpen(false)
                  void handleImageDefaultChange('size', v)
                }}
                ariaLabel="选择图片尺寸"
                title="尺寸"
              />
              {customSizeOpen && (
                <div className="image-custom-size-row">
                  <input
                    className="image-custom-size-input"
                    type="text"
                    value={customSizeInput}
                    onChange={(e) => setCustomSizeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void applyCustomSize()
                      }
                      if (e.key === 'Escape') setCustomSizeOpen(false)
                    }}
                    placeholder="例如 1536x1024"
                    aria-label="自定义图片尺寸"
                  />
                  <button className="image-custom-size-apply" onClick={() => void applyCustomSize()}>
                    应用
                  </button>
                </div>
              )}
            </>
          )}
          {qualityConfig?.enabled && (
            <Dropdown
              className="image-quality-selector"
              value={qualityValue}
              placeholder="质量"
              options={qualityOptions}
              onChange={(v) => void handleImageDefaultChange('quality', v)}
              ariaLabel="选择图片质量"
              title="质量"
            />
          )}
          {backgroundConfig?.enabled && (
            <Dropdown
              className="image-background-selector"
              value={backgroundValue}
              placeholder="背景"
              options={backgroundOptions}
              onChange={(v) => void handleImageDefaultChange('background', v)}
              ariaLabel="选择图片背景"
              title="背景"
            />
          )}
          {outputFormatConfig?.enabled && (
            <Dropdown
              className="image-format-selector"
              value={outputFormatValue}
              placeholder="格式"
              options={outputFormatOptions}
              onChange={(v) => setOutputFormatValue(v === PARAM_DEFAULT_VALUE ? '' : v)}
              ariaLabel="选择输出格式"
              title="输出格式"
            />
          )}
          <div className="composer-spacer" />
          {isGeneratingHere ? (
            <button className="send-btn stop-btn" onClick={handleStop} title="停止生成" aria-label="停止生成">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <rect x="2" y="2" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={() => void handleGenerate()}
              disabled={!text.trim() || !isImageProvider || !currentModelId}
              title="生成图片"
              aria-label="生成图片"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 13V3" />
                <path d="M3 8L8 3L13 8" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {dragOver && !isGeneratingHere && supportsImageToImage && (
        <div className="composer-drag-overlay">松开以添加参考图</div>
      )}
    </div>
  )
}
