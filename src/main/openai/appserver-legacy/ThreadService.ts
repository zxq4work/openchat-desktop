import { OpenAIAppServerClient } from './OpenAIAppServerClient'
import { APP_NAME } from '../../../shared/constants'

/**
 * 固定 Chat 模式指令，用于 OpenChat 表现为文本对话助手
 *
 * @deprecated Direct Provider 不使用此函数，systemPrompt 直接进入 request.instructions。
 */
export function buildDeveloperInstructions(conversationSystemPrompt: string): string {
  const appMode = `
You are operating inside OpenChat Desktop as a general-purpose
text conversation assistant.

Respond directly to the user's conversational request.

Do not run commands, inspect local files, edit files, use tools,
start subagents, search the web, or interact with external apps.
This client intentionally provides text conversation only.
`.trim()

  const userRole = conversationSystemPrompt.trim()

  if (!userRole) {
    return appMode
  }

  return `${appMode}

<conversation_role_instructions>
${userRole}
</conversation_role_instructions>`
}

/**
 * @deprecated Direct Provider 不使用 ThreadService，改为 stateless 请求。
 */
export class ThreadService {
  private client: OpenAIAppServerClient

  constructor(client: OpenAIAppServerClient) {
    this.client = client
  }

  async startThread(model: string, developerInstructions: string): Promise<string> {
    const result = await this.client.startThread({
      model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: APP_NAME,
      developerInstructions,
    })
    return result.thread.id
  }

  async resumeThread(threadId: string): Promise<string> {
    const result = await this.client.resumeThread({ threadId })
    return result.thread.id
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.client.deleteThread({ threadId })
  }
}