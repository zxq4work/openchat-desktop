import type { SearchCommands } from '../../../../shared/types/webSearch'
import { ChatGPTCodexSearchClient, WebSearchError } from '../search/ChatGPTCodexSearchClient'
import { DEFAULT_SEARCH_SETTINGS } from '../../../../shared/types/webSearch'

export interface WebSearchToolResult {
  callId: string
  output: string
  rawResults: unknown[]
  encryptedOutput?: string
}

export class WebSearchToolExecutor {
  private searchClient: ChatGPTCodexSearchClient

  constructor(searchClient: ChatGPTCodexSearchClient) {
    this.searchClient = searchClient
  }

  async execute(
    callId: string,
    commands: SearchCommands,
    currentModel: string,
    segmentId: string,
    currentUserText: string,
    signal?: AbortSignal
  ): Promise<WebSearchToolResult> {
    console.log('[WebTool Executor] Executing web.run for call:', callId)
    console.log('[WebTool Executor] Commands:', JSON.stringify(commands).slice(0, 500))

    const response = await this.searchClient.search(
      {
        id: segmentId,
        model: currentModel,
        input: currentUserText,
        commands,
        settings: { ...DEFAULT_SEARCH_SETTINGS },
        max_output_tokens: 6000,
      },
      signal
    )

    console.log('[WebTool Output] call:', callId, '| output length:', response.output.length)

    return {
      callId,
      output: response.output,
      rawResults: response.results ?? [],
      encryptedOutput: response.encrypted_output,
    }
  }
}