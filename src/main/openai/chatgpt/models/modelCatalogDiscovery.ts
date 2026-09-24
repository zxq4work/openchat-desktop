// ChatGPT Codex model-catalog DISCOVERY SENTINEL。
//
// 「99.99.99」不是 Codex runtime version，也不是 OpenChat 声明兼容的某个 Codex release。
// 它只是 GET /backend-api/codex/models 的 client_version query 参数值：
// 服务器目前要求该参数存在（省略会返回 400 Field required），
// 而 99.99.99 是 OpenAI 官方 models.json 更新 workflow 使用的 catalog discovery 值，
// 已在 OpenChat 真实 ChatGPT OAuth 身份下验证：返回当前完整 catalog（与最高 release 版本一致）。
//
// 语义边界：
//   - 只用于 /backend-api/codex/models
//   - 参数本身仍由 backend 要求，不能省略，不能改成 latest / 空字符串
//   - 不是 Codex runtime version
//   - 不跟随 Codex release 更新（不需要 Codex 0.156 / 0.157 时手动改这个值）
//   - 不代表 OpenChat 实现了所有官方 Codex features
//   - 不用于 /responses
//   - 不用于任何 Codex 版本兼容判定（与 Codex release / vendor schema 完全解耦）
//
// 能力判定一律交给 server metadata + OpenChat 自身 capability policy：
// use_responses_lite / supported_reasoning_levels / input_modalities /
// supports_search_tool / web_search_tool_type / visibility / supported_in_api。
export const CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL = '99.99.99'
