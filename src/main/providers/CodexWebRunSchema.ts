/**
 * Codex 官方 reserved web.run 匹配的完整 SearchCommands schema
 *
 * 对应 codex-rs/ext/web-search/ 中 WebSearchTool::spec() 的 commands_schema()
 * 生成规则: JSON Schema Draft 2019-09, inline_subschemas=true, no compaction
 *
 * 不要自行缩减字段，否则会触发 "web.run is reserved ... must match configured schema"
 */
export const CODEX_WEB_RUN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    search_query: {
      type: 'array',
      description: 'Search the web for the given queries. Returns search results with titles, URLs, snippets, and optional ref_id per result.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: {
            type: 'string',
            description: 'The search query string.',
          },
          recency: {
            type: 'number',
            description: 'Optional recency filter in days (e.g. 7 means last 7 days).',
          },
          domains: {
            type: 'array',
            description: 'Optional list of domains to restrict the search to.',
            items: {
              type: 'string',
            },
          },
        },
        required: ['q'],
      },
    },
    image_query: {
      type: 'array',
      description: 'Search for images matching the given queries.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', description: 'The image search query.' },
        },
        required: ['q'],
      },
    },
    open: {
      type: 'array',
      description: 'Open (fetch) a URL from a search result to read its full content. Use ref_id from search results to reference which result to open.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref_id: {
            type: 'string',
            description: 'The ref_id of the search result to open.',
          },
          lineno: {
            type: 'number',
            description: 'Optional line number to scroll to within the opened page.',
          },
        },
        required: ['ref_id'],
      },
    },
    click: {
      type: 'array',
      description: 'Click on an element within an opened page. Use ref_id to reference the opened page and id for the element.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref_id: {
            type: 'string',
            description: 'The ref_id of the opened page.',
          },
          id: {
            type: 'number',
            description: 'The id of the element to click.',
          },
        },
        required: ['ref_id', 'id'],
      },
    },
    find: {
      type: 'array',
      description: 'Find text within an opened page. Use ref_id to reference the opened page and pattern for the text to find.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref_id: {
            type: 'string',
            description: 'The ref_id of the opened page.',
          },
          pattern: {
            type: 'string',
            description: 'The text pattern to find.',
          },
        },
        required: ['ref_id', 'pattern'],
      },
    },
    screenshot: {
      type: 'object',
      description: 'Request a screenshot of the current viewport or a specific element.',
      additionalProperties: false,
      properties: {},
    },
    finance: {
      type: 'array',
      description: 'Get financial data for the given stock symbols or tickers.',
      items: {
        type: 'string',
      },
    },
    weather: {
      type: 'array',
      description: 'Get weather information for the given locations.',
      items: {
        type: 'string',
      },
    },
    sports: {
      type: 'array',
      description: 'Get sports scores, schedules, or news for the given queries.',
      items: {
        type: 'string',
      },
    },
    time: {
      type: 'array',
      description: 'Get current local time for the given locations or timezones.',
      items: {
        type: 'string',
      },
    },
    response_length: {
      type: 'string',
      description: 'Control the response length. Use "concise" for shorter responses or "detailed" for longer ones.',
    },
  },
}

/**
 * Codex 官方 web.run 工具的 description
 * 对应 codex-rs/ext/web-search/web_run_description.md
 */
export const CODEX_WEB_RUN_DESCRIPTION = `Web search tool for retrieving real-time information from the internet.

This tool provides access to current web content through multiple commands:

- **search_query**: Search the web and get results with titles, URLs, and snippets. Best for finding new information, current events, or verifying facts. Supports multiple simultaneous queries, recency filtering, and domain restrictions.
- **image_query**: Search for images on the web. Use when the user asks for pictures, photos, diagrams, or visual information.
- **open**: Fetch and read the full content of a web page. Use after search_query when you need more details from a specific result. Reference the result by its ref_id.
- **click**: Interact with elements on an opened page. Use when you need to navigate within a page.
- **find**: Search for specific text within an opened page. Use to locate information within a fetched page.
- **screenshot**: Capture a screenshot of the current viewport or a specific element.
- **finance**: Get real-time or historical financial data for stocks, ETFs, indices, and cryptocurrencies.
- **weather**: Get current weather conditions, forecasts, and alerts for locations worldwide.
- **sports**: Get live scores, schedules, standings, and news for various sports leagues.
- **time**: Get current local time, timezone information, and time conversions.
- **response_length**: Control the verbosity of the response. Use "concise" for brief answers or "detailed" for comprehensive explanations.

When to use this tool:
- The user asks about current events, recent news, or time-sensitive information
- The user wants to verify facts or find specific information from the web
- The user asks for financial data, weather, sports scores, or time information
- The user needs images, screenshots, or visual content from the web
- The user's question requires real-time or up-to-date data that may not be in your training data

Always cite sources when using information from web search results.`