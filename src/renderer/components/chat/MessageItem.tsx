import React from 'react'
import type { Message } from '../../../shared/types/conversation'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'

interface Props {
  message: Message
}

export const MessageItem = React.memo(function MessageItem({ message }: Props) {
  if (message.role === 'user') {
    return <UserMessage message={message} />
  }
  return <AssistantMessage message={message} />
})