// This is the ChatGPT Codex model-catalog compatibility version.
// It is not the bundled/vendored Codex runtime or protocol-schema version.
//
// 它只用于 GET /backend-api/codex/models?client_version=...
// 与 CODEX_VERSION / vendor/openai/codex-* / protocolSchemaVersion 完全解耦：
// 不要 import CODEX_VERSION，不要读取 vendor manifest，不要与之比较。
//
// OpenAI 仅发布新模型（/models 返回新 slug）时无需改动此值；
// 仅当服务器对 catalog 准入版本有新要求（minimal_client_version 高于此值）时才需要提升。
export const CHATGPT_MODEL_CATALOG_CLIENT_VERSION: string =
  process.env.OPENCHAT_CHATGPT_MODEL_CATALOG_VERSION?.trim()
  || '0.155.0'

// 仅当服务器明确返回「client_version 参数非法」的 4xx 时使用的保守回退版本。
// HTTP 200 + models=[] 不触发回退（空列表可能代表账号权限/rollout/策略）。
export const CHATGPT_MODEL_CATALOG_FALLBACK_VERSION = '0.154.0'
