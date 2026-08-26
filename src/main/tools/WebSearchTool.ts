import type { OpenChatTool, ToolExecutionContext } from './ToolRegistry'
import type { OpenChatToolDefinition, CanonicalToolResult, SearchResultItem } from '../../shared/types/provider'
import { WebSearchService } from '../web-search/WebSearchService'

export const WEB_SEARCH_TOOL_DEFINITION: OpenChatToolDefinition = {
  name: 'openchat_web_search',
  description:
    'Search the public web for current or externally verifiable information. ' +
    'Use it when the user explicitly asks to search, browse, look up or verify information, ' +
    'or when the answer depends on information that may have changed. ' +
    'Use concise search queries.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Concise web search query',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

export class WebSearchTool implements OpenChatTool {
  private searchService: WebSearchService

  definition = WEB_SEARCH_TOOL_DEFINITION

  constructor(searchService: WebSearchService) {
    this.searchService = searchService
  }

  async execute(args: unknown, context: ToolExecutionContext): Promise<CanonicalToolResult> {
    const query = (args as Record<string, unknown>)?.query
    if (typeof query !== 'string' || !query.trim()) {
      return {
        callId: '',
        name: 'openchat_web_search',
        output: JSON.stringify({ error: 'SEARCH_EMPTY_QUERY', message: 'Search query is empty' }),
        isError: true,
      }
    }

    console.log('[Web Search] query=', query)

    try {
      const results = await this.searchService.search(query, context.signal)
      console.log('[Web Search Result] count=', results.length)
      for (const r of results) {
        console.log(`[Web Search]   [${r.index}] ${r.title}`)
        console.log(`[Web Search]        url: ${r.url}`)
      }

      const output: { query: string; results: SearchResultItem[] } = {
        query,
        results,
      }

      return {
        callId: '',
        name: 'openchat_web_search',
        output: JSON.stringify(output),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Web Search Error]', message)

      // 提取错误码前缀，让模型能向用户解释具体原因
      let errorCode = 'SEARCH_ERROR'
      let userMessage = 'Web search failed'
      if (message.startsWith('SEARCH_')) {
        const colonIdx = message.indexOf(':')
        errorCode = colonIdx > 0 ? message.slice(0, colonIdx) : message
        userMessage = colonIdx > 0 ? message.slice(colonIdx + 2) : message
      }

      return {
        callId: '',
        name: 'openchat_web_search',
        output: JSON.stringify({ error: errorCode, message: userMessage }),
        isError: true,
      }
    }
  }
}