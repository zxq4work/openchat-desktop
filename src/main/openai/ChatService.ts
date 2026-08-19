import { OpenAIAppServerClient } from './OpenAIAppServerClient'
import type { UserInput } from '../../../vendor/openai/codex-0.148.0/schema-ts/v2/UserInput'

export interface TurnParams {
  threadId: string
  input: string  // 用户输入文本
  model?: string
  effort?: string
}

export class ChatService {
  private client: OpenAIAppServerClient

  constructor(client: OpenAIAppServerClient) {
    this.client = client
  }

  async startTurn(params: TurnParams): Promise<string> {
    const userInput: UserInput = {
      type: 'text',
      text: params.input,
      text_elements: [],
    }

    const turnParams: Record<string, unknown> = {
      threadId: params.threadId,
      input: [userInput],
    }

    if (params.model) {
      turnParams.model = params.model
    }

    if (params.effort) {
      turnParams.effort = params.effort
    }

    const result = await this.client.startTurn(turnParams as never)
    return result.turn.id
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.client.interruptTurn({ threadId, turnId })
  }

  onStreamEvent(handler: (method: string, params: unknown) => void): void {
    const methods = [
      'turn/started',
      'item/started',
      'item/agentMessage/delta',
      'item/completed',
      'turn/completed',
      'error',
    ]

    for (const method of methods) {
      this.client.onNotification(method, (params: unknown) => {
        handler(method, params)
      })
    }
  }
}