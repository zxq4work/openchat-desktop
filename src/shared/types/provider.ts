// 通用 Provider 协议无关的类型定义
// 模型 Adapter 只关心 API 协议（Chat Completions / Responses / ChatGPT Codex）
// Tool System 只使用这些 Canonical 类型

// Chat 协议：走 ModelAdapter.stream() 的文字对话协议
export type ChatProtocol =
  | 'chatgpt_codex'
  | 'chat_completions'
  | 'responses'

// Provider 协议全集。image_generations 与 Chat 协议同级，
// 对应 POST /v1/images/generations，不走 ModelAdapter（无 SSE、无 messages）。
export type ProviderProtocol =
  | ChatProtocol
  | 'image_generations'

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
  // 模型能力：来自 /models metadata（ModelInfo.useResponsesLite）。
  // 仅 chatgpt_codex 协议消费；undefined 表示 metadata 未声明，保持旧行为。
  responsesLite?: boolean
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

// 自定义 Provider 可选的协议：Chat Completions / Responses / Image Generations
export type CustomProviderProtocol = Exclude<ProviderProtocol, 'chatgpt_codex'>

export interface CustomProviderConfig {
  id: string
  name: string
  protocol: CustomProviderProtocol
  baseUrl: string
  apiKey: string
  models: string[]
  modelsPath?: string
  chatCompletionsPath?: string
  responsesPath?: string
  // Image Generations 请求路径，默认 /images/generations（baseUrl 已含 /v1 时）
  imageGenerationsPath?: string
  // Image Generations 参数能力 Profile（仅 protocol=image_generations 有意义）。
  // 未设置时按最小集处理（只发送 model/prompt/n）。
  imageGenerationProfile?: ImageGenerationParameterProfile
  extraHeaders?: Record<string, string>
  toolCalling: ToolCallingMode
  // 手动声明该自定义 Provider 的模型支持图片输入（无法从 metadata 推断时使用）。
  // 仅对 Chat 协议有意义；image_generations Provider 不使用该字段。
  imageInput?: boolean
  createdAt: number
  updatedAt: number
}

// ── Image Generation Parameter Profile ──
// protocol = image_generations 只说明走 POST /v1/images/generations，
// 不代表各 Provider 参数 contract 完全一致（有的不接受 output_format，有的不接受 size="auto"）。
// Profile 用于描述某 Provider 实际支持的参数集合与枚举值，由 UI / Service 共同消费。
// Provider 差异一律通过 Profile 描述，禁止在 Adapter 里按供应商名称特判。

export interface ImageGenerationParameterOption {
  label: string
  value: string
}

// 单个参数的能力配置。
// enabled=false → UI 不显示、请求不发送该字段。
// options 非空 → 仅允许列表内的值。
// allowCustom=true → 允许用户输入自定义值（按字段的基础格式校验）。
export interface ImageGenerationParameterConfig {
  enabled: boolean
  options?: ImageGenerationParameterOption[]
  allowCustom?: boolean
}

export interface ImageGenerationNConfig {
  enabled: boolean
  min: number
  max: number
  defaultValue?: number
}

// ── Generation Operation 能力（文生图 / 图生图）──
// 是否支持某操作必须来自 Profile，禁止根据 provider name / model name / baseUrl 猜测。

// 图生图（参考图生成）能力。
export interface ImageGenerationImageToImageConfig {
  enabled: boolean
  // 是否允许多张参考图；false 时仅允许 1 张。
  multiple: boolean
  // 最多参考图片数量。缺省时按 multiple 推导（true→MAX，false→1）。
  maxImages?: number
}

export interface ImageGenerationOperationProfile {
  // 文生图：无参考图请求。false 时 Service 拒绝 text_to_image。
  textToImage: boolean
  imageToImage: ImageGenerationImageToImageConfig
}

// ── Request Mapping v2（协议字段映射）──
// 这是「协议细节」，不是「用户能力」：普通用户无需理解，只在设置页的
// 「高级协议兼容设置」里暴露。核心代码绝不按供应商名称推断这些映射。
//
// 设计约束：
// - path 仅允许 '<顶层字段>' 或 'extra_body.<字段>'，拒绝任意嵌套与原型污染。
// - 本地受管图片只能以 Data URI 传输；不存在「公网 URL」编码选项。
// - response_format 只是「请求协议参数」，与图片输出格式（output_format）语义不同。
// - 返回体是 b64_json 还是 url 由 Adapter 自动识别，绝不要求用户选择。

// 参考图写入形式：single → 写入单个值（字符串）；array → 写入数组。
export type ImageGenerationInputCardinality = 'single' | 'array'

// 参考图编码方式。本地受管图片统一编码为 Data URI，故只有一种取值。
export type ImageGenerationInputEncoding = 'data_url'

export interface ImageGenerationInputImageMapping {
  // '<顶层字段>' 或 'extra_body.<字段>'
  path: string
  cardinality: ImageGenerationInputCardinality
  encoding: ImageGenerationInputEncoding
}

// response_format 字段的取值类型：string（如 'b64_json'）或 boolean（如 true）。
export type ImageGenerationResponseFormatValueType = 'string' | 'boolean'

export interface ImageGenerationResponseFormatMapping {
  // false → 不发送该字段（Provider 默认行为）。
  enabled: boolean
  // '<顶层字段>' 或 'extra_body.<字段>'
  path: string
  valueType: ImageGenerationResponseFormatValueType
  value: string | boolean
}

export interface ImageGenerationRequestMapping {
  // 参考图字段映射。缺失 = 不发送参考图（即便 operations 允许图生图）。
  inputImages?: ImageGenerationInputImageMapping
  // response_format 字段映射。
  responseFormatParameter?: ImageGenerationResponseFormatMapping
}

// Image Generation 能力 Profile（操作 + 参数 + 协议字段映射），分层清晰。
// - operations / 参数：用户能理解的「能力」
// - requestMapping：协议细节（高级设置）
export interface ImageGenerationParameterProfile {
  // Profile schema 版本。v2 起使用 requestMapping；v1 的 inputImages/response 会在
  // normalize 时迁移到 requestMapping，故旧库无需手工修改。
  version?: number
  size: ImageGenerationParameterConfig
  quality: ImageGenerationParameterConfig
  background: ImageGenerationParameterConfig
  outputFormat: ImageGenerationParameterConfig
  n?: ImageGenerationNConfig
  // 操作能力（文生图 / 图生图）。旧库缺失 → normalize 时回退为仅文生图。
  operations?: ImageGenerationOperationProfile
  // 协议字段映射（参考图位置 / response_format）。仅协议细节。
  requestMapping?: ImageGenerationRequestMapping
}

// Profile 预设标识：openai 官方兼容 / 自定义（含图生图扩展）/ 自定义最小集
export type ImageGenerationProfilePresetId = 'openai' | 'custom_image_to_image' | 'custom'

// ── Image Generations（POST /v1/images/generations）──

// Canonical 参考图引用：只保存 attachmentId + metadata，绝不长期保存 Base64。
// 真实字节由 Main 在构建 HTTP 请求时按需读取并编码（见 ImageGenerationInputResolver）。
export interface ImageGenerationInputImage {
  attachmentId: string
  mimeType: string
  fileName?: string
}

// 参考图字节解析器：Main 注入，Adapter 用它把 attachmentId → Buffer + MIME。
// 与 Chat 的 AttachmentResolver 语义分开：这里返回真实字节用于构造 Provider 请求体。
export interface ImageGenerationInputResolver {
  resolveForGeneration(attachmentId: string): { bytes: Uint8Array; mimeType: string } | null
}

// Adapter 构造请求体时所需的协议字段映射（由 Service 从 Provider Profile 派生）。
// Adapter 只按这张映射写入 body，绝不按供应商名称特判。
export interface ImageGenerationWireConfig {
  requestMapping?: ImageGenerationRequestMapping
}

// 图片生成请求的 Canonical 结构。Provider-specific JSON 只在 Adapter 层出现。
// inputImages 为空 / 未定义 = 文生图；非空 = 图生图。
export interface ImageGenerationRequest {
  prompt: string
  model: string
  size?: string
  quality?: string
  background?: string
  outputFormat?: string
  n?: number
  inputImages?: ImageGenerationInputImage[]
  // 参考图字节解析器（Main 注入）。inputImages 非空时必须提供。
  inputImageResolver?: ImageGenerationInputResolver
  // 参考图 wire 配置（Profile 派生），决定参考图放在 body 的哪个位置、如何编码。
  wire?: ImageGenerationWireConfig
}

// Adapter 返回的单张图片。字节已解码，Renderer 永远拿不到 Provider 原始响应。
// 用 Uint8Array 而非 Buffer，避免 shared 类型耦合 Node（主进程传 Buffer 兼容）。
export interface GeneratedImage {
  bytes: Uint8Array
  mimeType: string
  revisedPrompt?: string
}

export interface ImageGenerationResult {
  images: GeneratedImage[]
}

// 独立于 ModelAdapter：图片生成不是流式文字协议，没有 messages / tools / reasoning。
export interface ImageGenerationAdapter {
  readonly protocol: 'image_generations'
  generate(
    request: ImageGenerationRequest,
    signal?: AbortSignal
  ): Promise<ImageGenerationResult>
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
