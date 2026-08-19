import React from 'react'
import type { ContextSegment } from '../../../shared/types/conversation'

interface Props {
  segment: ContextSegment
}

export function ContextBoundary({ segment }: Props) {
  const label = segment.reason === 'new-topic'
    ? '新话题'
    : segment.reason === 'system-prompt-changed'
    ? '角色设定已更新'
    : segment.reason === 'provider-context-lost'
    ? '远端上下文不可恢复'
    : ''

  const description = segment.reason === 'new-topic'
    ? '上方对话不会作为后续模型上下文'
    : segment.reason === 'system-prompt-changed'
    ? '后续消息将使用新的角色设定和新的模型上下文'
    : ''

  return (
    <div className="context-boundary">
      <div className="boundary-line" />
      <div className="boundary-label">{label}</div>
      {description && <div className="boundary-description">{description}</div>}
      <div className="boundary-line" />
    </div>
  )
}