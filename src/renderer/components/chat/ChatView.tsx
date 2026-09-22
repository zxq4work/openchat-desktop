import React, { useEffect, useMemo } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'
import { MessageList } from './MessageList'
import { Composer } from '../composer/Composer'
import { ImageComposer } from '../composer/ImageComposer'
import { SearchBar } from './SearchBar'
import { AttachmentLightbox } from './AttachmentLightbox'
import { ContextMenu } from './ContextMenu'
import { deriveConversationPreviewImages } from '../../packages/conversationPreviewImages'

export function ChatView() {
  const activeConversation = useConversationStore((s) => s.activeConversation)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const activeMessages = useConversationStore((s) => s.activeMessages)
  const searchVisible = useUiStore((s) => s.searchVisible)
  const closeSearch = useUiStore((s) => s.closeSearch)
  const setLightboxImages = useUiStore((s) => s.setLightboxImages)

  // 当前会话可预览图片序列（纯派生，不查 DB）。顺序见 deriveConversationPreviewImages。
  const conversationImages = useMemo(() => deriveConversationPreviewImages(activeMessages), [activeMessages])

  // 序列写入全局：Lightbox 打开时按 attachmentId 在此序列中定位上一张/下一张。
  // 新图片随生成完成进入序列后，已打开的 Lightbox 不会自动跳过去 —— 只更新序列，不改当前 attachmentId。
  useEffect(() => {
    setLightboxImages(conversationImages)
  }, [conversationImages, setLightboxImages])

  // 切换对话时关闭搜索栏（Lightbox / 右键菜单在 conversationStore 切换处一并关闭）
  useEffect(() => {
    closeSearch()
  }, [activeConversationId, closeSearch])

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

  const isImageGeneration = activeConversation.type === 'image_generation'

  return (
    <div className={`chat-view${isImageGeneration ? ' chat-view--image' : ''}`}>
      <div className="chat-header">
        {isImageGeneration && (
          <span className="chat-type-icon" title="图片生成会话" aria-label="图片生成会话">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </span>
        )}
        <span className="chat-title">{activeConversation.title}</span>
      </div>
      {searchVisible && !isImageGeneration && <SearchBar />}
      <MessageList />
      {isImageGeneration ? <ImageComposer /> : <Composer />}
      <AttachmentLightbox />
      <ContextMenu />
    </div>
  )
}