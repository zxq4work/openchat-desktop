// 通用 Provider 协议无关的类型定义
// 模型 Adapter 只关心 API 协议（Chat Completions / Responses / ChatGPT Codex）
// Tool System 只使用这些 Canonical 类型

export type ProviderProtocol =
  | 'chatgpt_codex'
  | 'chat_completions'
  | 'responses'

export type CanonicalRole =
  | 'system'
  | 'developer'
  | 'user'
  | 'assistant'
  | 'tool'

export interface CanonicalToolCall {
  id: string
  name: string
  namespace?: string
  arguments: string
}

export interface CanonicalToolResult {
  callId: string
  name: string
  output: string
  isError?: boolean
  rawResults?: unknown[]
}

export interface CanonicalMessage {
  role: CanonicalRole
  content?: string
  toolCalls?: CanonicalToolCall[]
  toolResult?: CanonicalToolResult
  webSearchCalls?: CanonicalWebSearchCall[]
}

// 工具定义（JSON Schema 参数）
export interface OpenChatToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  toolType?: string // 工具类型，默认 'function'。Codex 原生工具如 'web_search' 需设置此字段
  namespace?: string // Codex namespaced client tool（如 web.run）
}

export interface CanonicalModelRequest {
  model: string
  systemPrompt?: string
  messages: CanonicalMessage[]
  tools?: OpenChatToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
  reasoningEffort?: string
  maxOutputTokens?: number
  temperature?: number
}

export type CanonicalModelEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning_started'; itemId?: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_completed'; itemId?: string; summary?: string[] }
  | { type: 'tool_call'; callId: string; name: string; namespace?: string; arguments: string }
  | { type: 'web_search_call'; phase: 'started' | 'searching' | 'completed' | 'failed'; itemId?: string; status?: string; action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string; sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> }; results?: unknown[] }
  | { type: 'turn_started'; turnId?: string }
  | { type: 'turn_completed'; turnId?: string }
  | { type: 'error'; code: string; message: string }

export interface ModelAdapter {
  readonly protocol: ProviderProtocol
  readonly capabilities: { toolCalling: boolean; reasoning: boolean }
  stream(
    request: CanonicalModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalModelEvent>
}

export type ToolCallingMode = 'auto' | 'enabled' | 'disabled'

export interface CustomProviderConfig {
  id: string
  name: string
  protocol: Exclude<ProviderProtocol, 'chatgpt_codex'>
  baseUrl: string
  apiKey: string
  models: string[]
  modelsPath?: string
  chatCompletionsPath?: string
  responsesPath?: string
  extraHeaders?: Record<string, string>
  toolCalling: ToolCallingMode
  createdAt: number
  updatedAt: number
}

// 搜索结果条目（WebSearchService 输出）
export interface SearchResultItem {
  index: number
  title: string
  url: string
  snippet: string
}

// web_fetch 输出
export interface WebFetchResult {
  url: string
  title: string
  content: string
  truncated: boolean
}

// --- Provider-native tool history (stored in providerPayloadJson) ---

export interface CanonicalWebSearchCall {
  id: string
  status?: string
  action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string; sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> }
}

export type ProviderPayloadItem =
  | { type: 'function_call'; call_id: string; name: string; namespace?: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'web_search_call'; id: string; status?: string; action?: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string; sources?: Array<{ url?: string; title?: string; type?: string; name?: string; snippet?: string }> } }

export interface ProviderPayloadV2 {
  provider: 'chatgpt_codex' | 'custom'
  protocol: ProviderProtocol
  items: ProviderPayloadItem[]
}
