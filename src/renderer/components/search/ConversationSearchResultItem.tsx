import React from 'react'
import type { ConversationSearchResult } from '../../../shared/types/search'
import { HighlightText } from './HighlightText'

interface Props {
  result: ConversationSearchResult
  query: string
  // 右侧当前打开的会话（独立于「用户选中」：只是一个轻量标记）
  active: boolean
  // 用户显式选中（点击 / 回车确认）
  selected: boolean
  // 键盘 ArrowUp / ArrowDown 当前停留的行
  keyboardActive: boolean
  onSelect: (result: ConversationSearchResult) => void
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

// 单条搜索结果：标题 + 更新时间 + 正文片段 + 匹配消息数量。
// 只负责展示与点击，不发起数据请求。
// 三种视觉状态互不重叠，且都由显式用户操作驱动（无任何默认高亮）：
//   data-active        —— 右侧当前打开的会话
//   data-selected      —— 用户点击 / 回车选中的结果
//   data-keyboard-active —— 方向键停留行
export const ConversationSearchResultItem = React.memo(function ConversationSearchResultItem({ result, query, active, selected, keyboardActive, onSelect }: Props) {
  return (
    <div
      className="search-result-item"
      data-active={active ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-keyboard-active={keyboardActive ? 'true' : undefined}
      onClick={() => onSelect(result)}
      title={result.title}
    >
      <div className="search-result-head">
        <span className="search-result-title">
          <HighlightText text={result.title} query={result.titleMatched ? query : ''} />
        </span>
        <span className="search-result-date">{formatDate(result.updatedAt)}</span>
      </div>
      {result.bestMatch && result.bestMatch.snippet && (
        <div className="search-result-snippet">
          <HighlightText text={result.bestMatch.snippet} query={query} />
        </div>
      )}
      {result.contentMatchCount > 0 && (
        <div className="search-result-count">{result.contentMatchCount} 条匹配消息</div>
      )}
    </div>
  )
})
