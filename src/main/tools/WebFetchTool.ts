import type { OpenChatTool, ToolExecutionContext } from './ToolRegistry'
import type { OpenChatToolDefinition, CanonicalToolResult } from '../../shared/types/provider'
import { WebFetchService } from '../web-search/WebFetchService'

export const WEB_FETCH_TOOL_DEFINITION: OpenChatToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch readable text from a public HTTP/HTTPS web page. ' +
    'Use this after web_search when a search snippet is insufficient ' +
    'and detailed information from a specific source is needed.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Public HTTP or HTTPS URL',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
}

export class WebFetchTool implements OpenChatTool {
  private fetchService: WebFetchService

  definition = WEB_FETCH_TOOL_DEFINITION

  constructor(fetchService: WebFetchService) {
    this.fetchService = fetchService
  }

  async execute(args: unknown, context: ToolExecutionContext): Promise<CanonicalToolResult> {
    const url = (args as Record<string, unknown>)?.url
    if (typeof url !== 'string' || !url.trim()) {
      return {
        callId: '',
        name: 'web_fetch',
        output: JSON.stringify({ error: 'FETCH_EMPTY_URL', message: 'URL is empty' }),
        isError: true,
      }
    }

    console.log('[Web Fetch] url=', url)

    try {
      const result = await this.fetchService.fetch(url, context.signal)
      console.log('[Web Fetch Result] title=', result.title, '| content length=', result.content.length)

      return {
        callId: '',
        name: 'web_fetch',
        output: JSON.stringify(result),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Web Fetch Error]', message)

      // 提取错误码
      let errorCode = 'FETCH_NETWORK_ERROR'
      if (message.startsWith('FETCH_')) {
        errorCode = message.split(':')[0]
      }

      return {
        callId: '',
        name: 'web_fetch',
        output: JSON.stringify({ error: errorCode, message }),
        isError: true,
      }
    }
  }
}