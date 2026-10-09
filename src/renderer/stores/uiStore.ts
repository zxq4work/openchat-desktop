import { create } from 'zustand'
import type { ConversationPreviewImage } from '../packages/conversationPreviewImages'
import { wrapIndex } from '../packages/conversationPreviewImages'

export interface SearchMatch {
  messageId: string
  globalIndex: number
  start: number
  end: number
}

// 通用右键菜单项。视觉由现有 .context-menu 承载，业务动作由调用方提供。
export interface ContextMenuItem {
  id: string
  label: string
  disabled?: boolean
  onClick: () => void
}

export interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}

const CLOSED_CONTEXT_MENU: ContextMenuState = { visible: false, x: 0, y: 0, items: [] }

interface UiState {
  sidebarCollapsed: boolean
  settingsDialogOpen: boolean
  conversationSettingsOpen: boolean
  conversationSettingsTargetId: string | null
  modelPickerOpen: boolean
  effortPickerOpen: boolean
  searchVisible: boolean
  searchQuery: string
  searchMatches: SearchMatch[]
  currentMatchIndex: number
  focusRequestId: number
  // 用户显式请求「重置上下文后滚动到底部」（Cmd/Ctrl+R 新话题）。
  // 与普通「新消息到达时的条件自动滚动」不同：这是用户主动导航，
  // 必须无视当前 READING_HISTORY / 贴底条件强制贴底一次。
  newTopicResetRequestId: number
  // 已被消费（完成贴底）到的请求 id 水位线。
  // 消费判定基于它而非组件局部 ref：组件重挂载后首次 effect 仍会执行，
  // 却不会重复消费历史请求；组件卸载期间发出的请求也因其大于水位线而不被遗漏。
  consumedNewTopicResetRequestId: number
  toast: string | null
  // 图片预览序列的稳定身份（attachmentId）。null = 关闭。
  // 不用下标作身份：会话内图片会随生成完成/删除增减，下标不稳定。
  lightboxAttachmentId: string | null
  // 当前会话可预览图片序列（仅由 ChatView 从 activeMessages 派生后写入）。
  lightboxImages: ConversationPreviewImage[]
  // 草稿预览记录：草稿不在 activeMessages 中，单独存放一份，不受会话序列更新影响。
  // 有值时该记录优先于 lightboxImages（仅在 attachmentId 匹配时）。
  lightboxStandalone: ConversationPreviewImage | null
  // 全局唯一右键菜单：任何时刻最多一个。
  contextMenu: ContextMenuState
  // 初始化失败 / 超时的降级错误态：非 null 时主界面替换为错误页 + 「重试初始化」。
  initError: { timedOut: boolean; message: string } | null
  initRetrying: boolean

  toggleSidebar: () => void
  requestComposerFocus: () => void
  requestScrollToBottomAfterReset: () => void
  // 原子「检查并消费」：若存在尚未消费的贴底请求，标记其已消费并返回 true；
  // 否则返回 false。把检查与推进水位线放在同一次 set 内，避免 remount / 多次
  // effect 执行导致的重复消费（局部 ref 无法跨挂载存活）。
  consumeNewTopicScrollIfPending: () => boolean
  showToast: (message: string) => void
  clearToast: () => void
  setSettingsDialogOpen: (open: boolean) => void
  setConversationSettingsOpen: (open: boolean) => void
  setConversationSettingsTargetId: (id: string | null) => void
  setModelPickerOpen: (open: boolean) => void
  setEffortPickerOpen: (open: boolean) => void
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void
  closeContextMenu: () => void
  setInitError: (error: { timedOut: boolean; message: string } | null) => void
  setInitRetrying: (retrying: boolean) => void
  setLightboxImages: (images: ConversationPreviewImage[]) => void
  openLightbox: (attachmentId: string, draft?: ConversationPreviewImage) => void
  closeLightbox: () => void
  lightboxPrev: () => void
  lightboxNext: () => void
  openSearch: () => void
  closeSearch: () => void
  setSearchQuery: (query: string) => void
  setSearchMatches: (matches: SearchMatch[]) => void
  setCurrentMatchIndex: (index: number) => void
  goToNextMatch: () => void
  goToPrevMatch: () => void
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  settingsDialogOpen: false,
  conversationSettingsOpen: false,
  conversationSettingsTargetId: null,
  modelPickerOpen: false,
  effortPickerOpen: false,
  searchVisible: false,
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,
  focusRequestId: 0,
  newTopicResetRequestId: 0,
  consumedNewTopicResetRequestId: 0,
  toast: null,
  lightboxAttachmentId: null,
  lightboxImages: [],
  lightboxStandalone: null,
  contextMenu: CLOSED_CONTEXT_MENU,
  initError: null,
  initRetrying: false,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  requestComposerFocus: () => set((state) => ({ focusRequestId: state.focusRequestId + 1 })),
  requestScrollToBottomAfterReset: () => set((state) => ({ newTopicResetRequestId: state.newTopicResetRequestId + 1 })),
  consumeNewTopicScrollIfPending: () => {
    const { newTopicResetRequestId, consumedNewTopicResetRequestId } = get()
    if (newTopicResetRequestId <= consumedNewTopicResetRequestId) return false
    // 推进水位线到当前请求：同一请求在 remount / 重复 effect 中不再被消费，
    // 而之后（含组件未挂载期间）发出的更大 id 仍会被消费，不遗漏。
    set({ consumedNewTopicResetRequestId: newTopicResetRequestId })
    return true
  },
  showToast: (message) => set({ toast: message }),
  clearToast: () => set({ toast: null }),
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  setConversationSettingsOpen: (open) => set({ conversationSettingsOpen: open }),
  setConversationSettingsTargetId: (id) => set({ conversationSettingsTargetId: id }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),

  openContextMenu: (x, y, items) => set({ contextMenu: { visible: true, x, y, items } }),
  closeContextMenu: () => set({ contextMenu: CLOSED_CONTEXT_MENU }),
  setInitError: (error) => set({ initError: error, initRetrying: false }),
  setInitRetrying: (retrying) => set({ initRetrying: retrying }),

  setLightboxImages: (images) => set({ lightboxImages: images }),
  // draft 有值 = 草稿预览（无导航序列）；否则按当前会话序列定位（由 ChatView 派生的 lightboxImages）。
  openLightbox: (attachmentId, draft) =>
    set({ lightboxAttachmentId: attachmentId, lightboxStandalone: draft ?? null }),
  closeLightbox: () => set({ lightboxAttachmentId: null, lightboxStandalone: null, contextMenu: CLOSED_CONTEXT_MENU }),
  lightboxPrev: () => {
    const { lightboxImages, lightboxAttachmentId } = get()
    const count = lightboxImages.length
    if (count <= 1 || !lightboxAttachmentId) return
    const current = lightboxImages.findIndex((img) => img.attachmentId === lightboxAttachmentId)
    if (current < 0) return
    set({ lightboxAttachmentId: lightboxImages[wrapIndex(current, -1, count)].attachmentId })
  },
  lightboxNext: () => {
    const { lightboxImages, lightboxAttachmentId } = get()
    const count = lightboxImages.length
    if (count <= 1 || !lightboxAttachmentId) return
    const current = lightboxImages.findIndex((img) => img.attachmentId === lightboxAttachmentId)
    if (current < 0) return
    set({ lightboxAttachmentId: lightboxImages[wrapIndex(current, 1, count)].attachmentId })
  },

  openSearch: () => set({ searchVisible: true, searchQuery: '', searchMatches: [], currentMatchIndex: -1 }),
  closeSearch: () => set({ searchVisible: false, searchQuery: '', searchMatches: [], currentMatchIndex: -1 }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchMatches: (matches) => set({ searchMatches: matches, currentMatchIndex: matches.length > 0 ? 0 : -1 }),
  setCurrentMatchIndex: (index) => set({ currentMatchIndex: index }),
  goToNextMatch: () => {
    const { searchMatches, currentMatchIndex } = get()
    if (searchMatches.length === 0) return
    const next = (currentMatchIndex + 1) % searchMatches.length
    set({ currentMatchIndex: next })
  },
  goToPrevMatch: () => {
    const { searchMatches, currentMatchIndex } = get()
    if (searchMatches.length === 0) return
    const prev = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length
    set({ currentMatchIndex: prev })
  },
}))