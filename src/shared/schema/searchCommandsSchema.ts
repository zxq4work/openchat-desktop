// web.run 工具的 JSON Schema —— 单一来源
// 与 shared/types/webSearch.ts 中的 SearchCommands 保持一致
export const SEARCH_COMMANDS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    search_query: {
      type: 'array',
      description: 'Run one or more web searches.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q'],
        properties: {
          q: { type: 'string', description: 'The search query.' },
          recency: {
            type: 'number',
            description: 'Restrict results to within this many days.',
          },
          domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict results to these domains.',
          },
        },
      },
    },
    image_query: {
      type: 'array',
      description: 'Run one or more image searches.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q'],
        properties: {
          q: { type: 'string', description: 'The image search query.' },
        },
      },
    },
    open: {
      type: 'array',
      description: 'Open a search result reference by its id.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref_id'],
        properties: {
          ref_id: { type: 'string', description: 'Reference id of the result to open.' },
          lineno: { type: 'number', description: 'Optional line number to scroll to.' },
        },
      },
    },
    click: {
      type: 'array',
      description: 'Click a link within an opened page.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref_id', 'id'],
        properties: {
          ref_id: { type: 'string', description: 'Reference id of the page.' },
          id: { type: 'number', description: 'Link id to click.' },
        },
      },
    },
    find: {
      type: 'array',
      description: 'Find text within an opened page.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref_id', 'pattern'],
        properties: {
          ref_id: { type: 'string', description: 'Reference id of the page.' },
          pattern: { type: 'string', description: 'Text pattern to find.' },
        },
      },
    },
    screenshot: {
      type: 'object',
      description: 'Take a screenshot of the current viewport or a specific element.',
      additionalProperties: false,
      properties: {},
    },
    finance: {
      type: 'array',
      description: 'Get financial data for the given stock symbols or tickers.',
      items: { type: 'string' },
    },
    weather: {
      type: 'array',
      description: 'Get weather information for the given locations.',
      items: { type: 'string' },
    },
    sports: {
      type: 'array',
      description: 'Get sports scores, schedules, or news for the given queries.',
      items: { type: 'string' },
    },
    time: {
      type: 'array',
      description: 'Get current local time for the given locations or timezones.',
      items: { type: 'string' },
    },
    response_length: {
      type: 'string',
      description: 'Control the response length. Use "concise" for shorter responses or "detailed" for longer ones.',
    },
  },
} as const
