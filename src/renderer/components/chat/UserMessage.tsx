import React from 'react'
import type { Message } from '../../../shared/types/conversation'

interface Props {
  message: Message
}

export function UserMessage({ message }: Props) {
  return (
    <div className="message user-message" data-message-id={message.id}>
      <div className="message-role">用户</div>
      <div className="message-content">{message.content}</div>
    </div>
  )
}