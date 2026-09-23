import React from 'react'
import { splitMatchedText } from '../../../shared/search/conversationSearch'

interface Props {
  text: string
  query: string
}

// 安全关键词高亮：按 query 拆分字符串为 React 节点，不使用 dangerouslySetInnerHTML（避免 XSS）。
// 大小写不敏感匹配，保留原文大小写。
export function HighlightText({ text, query }: Props) {
  const parts = splitMatchedText(text, query)
  if (!query) return <>{text}</>
  return (
    <>
      {parts.map((p, i) =>
        p.matched ? <mark key={i} className="search-panel-highlight">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>
      )}
    </>
  )
}
