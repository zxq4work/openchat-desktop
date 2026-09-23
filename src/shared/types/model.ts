// 模型信息来自 ChatGPT /models 端点，禁止硬编码。
// 所有能力 metadata 字段一律 optional：服务器新增未知字段时不影响解析。
export interface SupportedReasoningEffort {
  // 服务器返回的原始 effort 字符串（不限于本地已知枚举，未知值必须原样保留）。
  reasoningEffort: string
  description?: string | null
}

export interface ServiceTierInfo {
  id: string
  name?: string
  description?: string
}

export interface ModelInfo {
  id: string
  model: string
  displayName: string
  description?: string
  hidden: boolean

  defaultReasoningEffort?: string | null

  supportedReasoningEfforts: SupportedReasoningEffort[]

  inputModalities?: string[]
  supportsPersonality?: boolean
  isDefault?: boolean

  // ── 能力 metadata（全部 optional；缺失时保持旧行为，绝不因缺失改变请求）──
  // minimalClientVersion 仅作 diagnostic metadata：官方 Codex client 的最低 release requirement。
  // 不参与 visibility / 默认模型 / request 阻塞等任何 capability 判定。
  minimalClientVersion?: string
  supportedInApi?: boolean
  priority?: number

  // Responses Lite：由 /models metadata 驱动，决定是否发送该请求 header。
  useResponsesLite?: boolean
  supportsReasoningEffortUpdates?: boolean
  supportsParallelToolCalls?: boolean

  supportsImageDetailOriginal?: boolean

  contextWindow?: number
  maxContextWindow?: number
  effectiveContextWindowPercent?: number

  // Hosted search 能力。undefined = 服务器未声明（保持现有行为）；
  // 仅当明确为 false 时才认为模型不具备 catalog 声明的 hosted search。
  supportsSearchTool?: boolean
  webSearchToolType?: string | null

  supportVerbosity?: boolean
  defaultVerbosity?: string

  // Codex Agent 私有语义（code_mode_only 等）。仅保存，OpenChat 不做 Code Mode。
  toolMode?: string | null

  serviceTiers?: ServiceTierInfo[]
  defaultServiceTier?: string | null
  additionalSpeedTiers?: string[]
}

// 推理等级是模型能力，客户端不静态枚举限制。
export type ReasoningEffortId = string
