// web.run 工具的 JSON Schema
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
          recency: { type: 'number' },
          domains: { type: 'array', items: { type: 'string' } },
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
      type: 'array',
      description: 'Take a screenshot of an opened page.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref_id', 'pageno'],
        properties: {
          ref_id: { type: 'string', description: 'Reference id of the page.' },
          pageno: { type: 'number', description: 'Page number to capture.' },
        },
      },
    },
    finance: {
      type: 'array',
      description: 'Finance data operations.',
      items: { type: 'object' },
    },
    weather: {
      type: 'array',
      description: 'Weather data operations.',
      items: { type: 'object' },
    },
    sports: {
      type: 'array',
      description: 'Sports data operations.',
      items: { type: 'object' },
    },
    time: {
      type: 'array',
      description: 'Time data operations.',
      items: { type: 'object' },
    },
    response_length: {
      type: 'string',
      enum: ['short', 'medium', 'long'],
      description: 'Desired length of the search response.',
    },
  },
} as const
