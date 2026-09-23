import { create } from 'zustand'
import type {
  ConversationSearchResult,
  ConversationMessageSearchMatch,
  ConversationSearchScope,
} from '../../shared/types/search'

// 全局会话搜索的 UI session 状态（不落库，App 重启不恢复）。
// 与普通 Sidebar 浏览模式互斥：active=true 时左侧显示 Search Mode。
interface ConversationSearchState {
  // 是否处于 Search Mode（左侧替代普通会话列表）
  active: boolean
  query: string
  scope: ConversationSearchScope
  loading: boolean
  error: string | null
  results: ConversationSearchResult[]
  // 用户显式选中的搜索结果（点击 / 键盘回车），仅用于视觉高亮。
  // 初始为 null，绝不默认指向 results[0]；与 activeConversationId 是两个独立概念。
  selectedConversationId: string | null
  // 左侧结果列表滚动位置（切会话 / 重渲染时保持）
  resultScrollTop: number

  // 当前会话命中导航（右侧轻量搜索条）
  navBarVisible: boolean
  navConversationId: string | null
  activeMatches: ConversationMessageSearchMatch[]
  activeMatchIndex: number
  // 触发 MessageList 定位的请求令牌：每次显式跳转 +1
  locateRequestId: number
  // 定位成功那一刻「冻结」的搜索关键词快照（点选结果时写入）。
  // 关键词高亮只认这个快照，而不是左侧实时输入框，避免每敲一个字符就重算整列高亮。
  highlightQuery: string

  enterSearchMode: () => void
  exitSearchMode: () => void
  setSearchQuery: (query: string) => void
  setSearchScope: (scope: ConversationSearchScope) => void
  setLoading: (loading: boolean) => void
  setSearchResults: (results: ConversationSearchResult[], error?: string | null) => void
  selectSearchResult: (conversationId: string | null) => void
  setResultScrollTop: (scrollTop: number) => void

  closeNavBar: () => void
  setActiveMatches: (matches: ConversationMessageSearchMatch[], conversationId: string) => void
  setActiveMatchIndex: (index: number) => void
  nextMatch: () => void
  prevMatch: () => void
  // 显式跳转到某个匹配消息（用于点击搜索结果后定位 bestMatch）
  jumpToMatch: (index: number) => void
  // 写入/清除定位关键词快照
  setHighlightQuery: (query: string) => void
}

// 退出 Search Mode 时保留 query / scope（误退出后可快速返回并重新搜索），
// 但清除当前会话命中导航会话态。
export const useConversationSearchStore = create<ConversationSearchState>((set, get) => ({
  active: false,
  query: '',
  scope: 'all',
  loading: false,
  error: null,
  results: [],
  selectedConversationId: null,
  resultScrollTop: 0,

  navBarVisible: false,
  navConversationId: null,
  activeMatches: [],
  activeMatchIndex: -1,
  locateRequestId: 0,
  highlightQuery: '',

  enterSearchMode: () => set({ active: true }),

  exitSearchMode: () => set({
    active: false,
    // 只有左侧退出；右侧当前会话保持不变
    selectedConversationId: null,
    navBarVisible: false,
    navConversationId: null,
    activeMatches: [],
    activeMatchIndex: -1,
    highlightQuery: '',
  }),

  setSearchQuery: (query) => set({ query }),
  setSearchScope: (scope) => set({ scope }),
  setLoading: (loading) => set({ loading }),

  // 新结果集：若用户先前选中的会话已不在结果中，则清空选中（回落到「无选中」，
  // 而不是自动选中新 results[0]）。刷新结果绝不自动打开/自动选中任何会话。
  setSearchResults: (results, error = null) => set((state) => ({
    results,
    error,
    loading: false,
    selectedConversationId: results.some((r) => r.conversationId === state.selectedConversationId)
      ? state.selectedConversationId
      : null,
  })),

  selectSearchResult: (conversationId) => set({ selectedConversationId: conversationId }),
  setResultScrollTop: (scrollTop) => set({ resultScrollTop: scrollTop }),

  closeNavBar: () => set({ navBarVisible: false, navConversationId: null, activeMatches: [], activeMatchIndex: -1, highlightQuery: '' }),

  // 打开/切换会话时写入该会话的匹配消息：有匹配则显示导航，否则隐藏。
  // 同一会话内匹配数量不变时保持当前 index，避免无谓跳动。
  setActiveMatches: (matches, conversationId) => {
    const state = get()
    if (state.navConversationId === conversationId && state.activeMatches.length === matches.length) {
      set({ activeMatches: matches, navBarVisible: matches.length > 0 })
      return
    }
    set({
      activeMatches: matches,
      navConversationId: conversationId,
      activeMatchIndex: matches.length > 0 ? 0 : -1,
      navBarVisible: matches.length > 0,
    })
  },

  setActiveMatchIndex: (index) => set({ activeMatchIndex: index, locateRequestId: get().locateRequestId + 1 }),

  nextMatch: () => {
    const { activeMatches, activeMatchIndex } = get()
    if (activeMatches.length === 0) return
    const next = (activeMatchIndex + 1) % activeMatches.length
    set({ activeMatchIndex: next, locateRequestId: get().locateRequestId + 1 })
  },

  prevMatch: () => {
    const { activeMatches, activeMatchIndex } = get()
    if (activeMatches.length === 0) return
    const prev = (activeMatchIndex - 1 + activeMatches.length) % activeMatches.length
    set({ activeMatchIndex: prev, locateRequestId: get().locateRequestId + 1 })
  },

  jumpToMatch: (index) => {
    const { activeMatches } = get()
    if (index < 0 || index >= activeMatches.length) return
    set({ activeMatchIndex: index, locateRequestId: get().locateRequestId + 1 })
  },

  setHighlightQuery: (query) => set({ highlightQuery: query }),
}))
