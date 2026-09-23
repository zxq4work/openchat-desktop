import React from 'react'
import type { ConversationSearchScope } from '../../../shared/types/search'

interface Props {
  scope: ConversationSearchScope
  onChange: (scope: ConversationSearchScope) => void
}

const TABS: Array<{ value: ConversationSearchScope; label: string }> = [
  { value: 'all', label: '标题与内容' },
  { value: 'title', label: '仅标题' },
  { value: 'content', label: '仅内容' },
]

// 搜索范围 segmented control（不使用 Dropdown）。
export function SearchScopeTabs({ scope, onChange }: Props) {
  return (
    <div className="search-scope-tabs" role="tablist" aria-label="搜索范围">
      {TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={scope === tab.value}
          className={`search-scope-tab${scope === tab.value ? ' active' : ''}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
