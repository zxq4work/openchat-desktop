import type { OpenChatTool, ToolExecutionContext } from '../../../tools/ToolRegistry'
import type { OpenChatToolDefinition, CanonicalToolResult, CanonicalMessage } from '../../../../shared/types/provider'
import type { SearchCommands, ProviderResponseItem } from '../../../../shared/types/webSearch'
import { SEARCH_COMMANDS_JSON_SCHEMA } from '../../../../shared/schema/searchCommandsSchema'
import { ChatGPTCodexStandaloneSearchClient } from '../search/ChatGPTCodexStandaloneSearchClient'
import { DEFAULT_SEARCH_SETTINGS } from '../../../../shared/types/webSearch'
import { randomUUID } from 'crypto'

export const CODEX_WEB_RUN_TOOL_DEFINITION: OpenChatToolDefinition = {
  name: 'run',
  namespace: 'web',
  description: 'Search the web for real-time information. Use this when the user asks about current events, recent data, or anything requiring up-to-date knowledge.',
  parameters: SEARCH_COMMANDS_JSON_SCHEMA as unknown as Record<string, unknown>,
}

export class CodexStandaloneWebRunTool implements OpenChatTool {
  private searchClient: ChatGPTCodexStandaloneSearchClient
  private modelId: string
  private segmentId: string
  private conversationMessages: CanonicalMessage[]
  definition = CODEX_WEB_RUN_TOOL_DEFINITION

  constructor(
    searchClient: ChatGPTCodexStandaloneSearchClient,
    modelId: string,
    segmentId: string,
    conversationMessages: CanonicalMessage[]
  ) {
    this.searchClient = searchClient
    this.modelId = modelId
    this.segmentId = segmentId
    this.conversationMessages = conversationMessages
  }

  async execute(args: unknown, context: ToolExecutionContext): Promise<CanonicalToolResult> {
    const commands: SearchCommands = (args ?? {}) as SearchCommands

    // 从 conversation messages 构建结构化 input（ProviderResponseItem[]）
    const inputItems = this.buildRecentContext()

    try {
      const response = await this.searchClient.search(
        {
          id: this.segmentId || randomUUID(),
          model: context.modelId || this.modelId,
          input: inputItems,
          commands,
          settings: { ...DEFAULT_SEARCH_SETTINGS },
          max_output_tokens: 6000,
        },
        context.signal
      )

      console.log('[StandaloneSearch] inputType=items recentItems=%d', inputItems.length)

      return {
        callId: '',
        name: 'run',
        output: response.output,
        rawResults: response.rawResults,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        callId: '',
        name: 'run',
        output: `Error: ${message}`,
        isError: true,
      }
    }
  }

  // 从 canonical messages 构建结构化 input（给 alpha/search 提供语义背景）
  // 转换为 ProviderResponseItem[] 格式，只取最近几轮 user/assistant
  // 不包含 system/developer/tool output，不包含当前 turn 新产生的 function_call_output
  private buildRecentContext(): ProviderResponseItem[] {
    const items: ProviderResponseItem[] = []
    // 只取最近几轮 user/assistant 消息
    const recentMessages = this.conversationMessages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .slice(-6)

    for (const m of recentMessages) {
      if (m.role === 'user') {
        items.push({ type: 'message', role: 'user', content: (m.content ?? '').slice(0, 500) })
      } else if (m.role === 'assistant' && m.content) {
        items.push({ type: 'message', role: 'assistant', content: m.content.slice(0, 500) })
      }
    }
    return items
  }
}
