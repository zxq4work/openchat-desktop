---
name: Codex Web Search Implementation Guide
description: 完整的 Codex 官方 Web Search 实现指南，使用 Responses Lite + web.run namespace + alpha/search endpoint
type: reference
---

# Codex 官方 Web Search 实现指南

## 核心原则
- Codex 使用 `use_responses_lite` + `namespace=web` + `tool=run` + `/alpha/search`
- 不使用 hosted web_search，不使用 openchat_web_search
- 自定义 Provider 继续使用 openchat_web_search + Bing/Baidu/Google
- 两条路径完全独立

## 请求结构
- Responses Lite: 必须设置 header `x-openai-internal-codex-responses-lite: true`
- 无 top-level tools，tools 在 input[0] 作为 additional_tools
- additional_tools 结构: `{ type: "additional_tools", role: "developer", id: "at_xxx", tools: [{ type: "namespace", name: "web", tools: [{ type: "function", name: "run", ... }] }] }`

## web.run Schema
- 支持命令: search_query, open, find, image_query, screenshot, weather, sports, time, response_length
- search_query: `{ q: string, recency?: number, domains?: string[] }`，最多 4 个 query

## alpha/search endpoint
- POST https://chatgpt.com/backend-api/codex/alpha/search
- 带 OAuth Authorization + ChatGPT-Account-Id
- 请求: `{ id: session_id, model, commands, max_output_tokens }`
- 返回: `{ output, results? }`

## function_call 处理
- 识别: `item.type === "function_call" && item.namespace === "web" && item.name === "run"`
- call_id 用于 function_call_output 回传，不是 SearchRequest.id

## 模型元数据
- 从 /backend-api/codex/models 读取 use_responses_lite, supports_search_tool, tool_mode
- 不要硬编码模型名判断

## 日志规范
- [Codex Search Strategy] model=... useResponsesLite=... strategy=...
- [Codex Responses] responsesLite=... topLevelTools=false additionalTools=true
- [Codex Tool Call] namespace=web name=run callId=...
- [Codex Search] endpoint=/backend-api/codex/alpha/search
- 禁止打印 OAuth token 和完整对话