OpenChat Desktop OpenAI protocol baseline

================================================================
HISTORICAL — REMOVED 2026-09-24
================================================================

该文件此前记录的是 **Codex App Server (stdio JSONL RPC)** 协议基线
（Codex 0.148.0 / tag rust-v0.148.0 / commit 3ba0f71）。

该 legacy 传输层及其生成的 schema 已整体删除：

- 删除的代码：`src/main/openai/appserver-legacy/**`、根目录 shim
  （AppServerProcess / AppServerRpcClient / OpenAIAppServerClient / ThreadService）、
  `AuthService` / `ModelService` / `ChatService`、`conversation/ConversationService`、
  `protocol-facade`、`scripts/mock-app-server.mjs`
- 删除的 schema：`vendor/openai/codex-0.148.0/`（整个 snapshot）
- 删除的常量：`CODEX_VERSION` / `CODEX_TAG` / `CODEX_COMMIT`
- 删除的开关：`OPENCHAT_PROVIDER=appserver` / `OPENCHAT_APP_SERVER_MODE`

**OpenChat 当前不依赖任何本地 Codex 二进制或 vendor schema。**

----------------------------------------------------------------
Current baseline (直接 HTTP/SSE)
----------------------------------------------------------------

Transport:
直连 ChatGPT Codex HTTP/SSE（Main Process 内 HTTPS 请求），无本地 Codex 进程。

Models:
GET  /backend-api/codex/models?client_version=99.99.99
     （99.99.99 为 catalog discovery sentinel，非 Codex 版本号）

Responses:
POST /backend-api/codex/responses

Auth:
ChatGPT OAuth（`src/main/openai/chatgpt/auth/`）

Streaming:
Codex SSE 事件（`src/main/openai/chatgpt/transport/ResponsesStreamParser.ts`）
