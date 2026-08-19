// 模型信息来自 model/list，禁止硬编码
export interface ModelInfo {
  id: string
  model: string
  displayName: string
  hidden: boolean

  defaultReasoningEffort?: string | null

  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description?: string | null
  }>

  inputModalities?: string[]
  supportsPersonality?: boolean
  isDefault?: boolean
}

// 推理等级是模型能力，客户端不静态枚举限制
export type ReasoningEffortId = string