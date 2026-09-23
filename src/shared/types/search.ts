// 全局会话搜索（Global Conversation Search）类型定义。
// 搜索范围：'all' 标题+正文；'title' 仅标题；'content' 仅正文。
// 正文只匹配用户可见消息内容（user message / assistant final content），
// 绝不匹配 reasoning / tool call / tool result / metadata。

export type ConversationSearchScope = 'all' | 'title' | 'content'

export interface ConversationSearchRequest {
  query: string
  scope: ConversationSearchScope
}

// 当前会话内单条匹配消息。
export interface ConversationMessageSearchMatch {
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  createdAt: number
}

// 全局搜索结果（按 Conversation 聚合，一个会话只出现一次）。
export interface ConversationSearchResult {
  conversationId: string
  title: string
  updatedAt: number
  // 标题是否命中（用于标题高亮 / 排序）
  titleMatched: boolean
  // 包含关键词的 message 数量（同一 message 多次出现只算 1 条）
  contentMatchCount: number
  // 正文最佳命中片段（仅 content 命中时存在）
  bestMatch?: ConversationMessageSearchMatch
}
