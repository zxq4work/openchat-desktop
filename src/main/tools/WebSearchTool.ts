import type { OpenChatTool, ToolExecutionContext } from './ToolRegistry'
import type { OpenChatToolDefinition, CanonicalToolResult, SearchResultItem } from '../../shared/types/provider'
import { WebSearchService } from '../web-search/WebSearchService'

export const WEB_SEARCH_TOOL_DEFINITION: OpenChatToolDefinition = {
  name: 'web_search',
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
        name: 'web_search',
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
        name: 'web_search',
        output: JSON.stringify(output),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Web Search Error]', message)

      return {
        callId: '',
        name: 'web_search',
        output: JSON.stringify({ error: 'SEARCH_NETWORK_ERROR', message: 'Web search failed' }),
        isError: true,
      }
    }
  }
}