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

// 多模态输入片段：ConversationService 不感知协议差异，由 Adapter 负责映射。
// 图片只携带 attachmentId，真实字节由主进程按需读取，避免 Base64 常驻内存。
export type CanonicalInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string; detail?: 'auto' | 'low' | 'high' }

// 附件解析回调：给定 attachmentId，返回可被各 Adapter 编码的受控文件描述。
// 由主进程 AttachmentService 提供，Adapter 通过 CanonicalModelRequest 拿到。
export interface AttachmentResolver {
  resolveForProvider(attachmentId: string):
    | { storagePath: string; mimeType: string; width: number; height: number; detail?: 'auto' | 'low' | 'high' }
    | null
}

export interface CanonicalMessage {
  role: CanonicalRole
  content?: string
  // 多模态输入（仅 user 消息使用）。存在时 content 仍可作为纯文本回退。
  inputParts?: CanonicalInputPart[]
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
  // 图片附件的受控解析器（主进程注入），Adapter 用它把 attachmentId → 文件
  attachmentResolver?: AttachmentResolver
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
  readonly capabilities: { toolCalling: boolean; reasoning: boolean; supportsImageInput: boolean }
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
  // 手动声明该自定义 Provider 的模型支持图片输入（无法从 metadata 推断时使用）
  imageInput?: boolean
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
