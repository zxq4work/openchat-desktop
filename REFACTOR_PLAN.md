# Multi-Provider Architecture + Independent Web Search Tool Refactoring

## Context

OpenChat Desktop currently has a single hardcoded model provider: ChatGPT Codex (OAuth-based, calling `chatgpt.com/backend-api/codex/responses`). Web search is tightly coupled to Codex's `/alpha/search` endpoint. This refactoring decouples model providers from tools, adds support for OpenAI Chat Completions Compatible and Responses Compatible APIs, and implements an independent web search system using Bing HTML parsing.

## Implementation Plan

### Phase 1: Canonical Types + ModelAdapter Interface

**New file: `src/shared/types/provider.ts`**
- `CanonicalRole`, `CanonicalMessage`, `CanonicalToolCall`, `CanonicalToolResult`
- `OpenChatToolDefinition` (name, description, parameters as JSON Schema)
- `CanonicalModelRequest` (modelId, messages, systemPrompt, tools, reasoningEffort)
- `CanonicalModelEvent` (delta, reasoning_started/completed, tool_call, turn_started/completed, error)
- `ModelAdapter` interface: `stream(request, signal) → AsyncIterable<CanonicalModelEvent>`
- `CustomProviderConfig` type: id, name, protocol, baseUrl, apiKey, modelId, toolCalling, modelsPath, chatCompletionsPath, responsesPath, extraHeaders

**Modified: `src/shared/types/index.ts`** — add `export * from './provider'`

**Modified: `src/shared/types/conversation.ts`** — add `providerConfigId: string | null` to Conversation

**Modified: `src/main/storage/StorageService.ts`** — add migration for `provider_config_id` column on conversations, add `provider_configs` table

**Modified: `src/main/storage/ConversationRepository.ts`** — handle `providerConfigId` field + `updateProviderConfigId()`

### Phase 2: WebSearchService + BingHtmlSearchEngine

**New dependency: `cheerio@1.0.0-rc.12`** (exact version, no caret)

**New file: `src/main/web-search/WebSearchService.ts`**
- Interface `SearchEngine` with `search(query, signal) → WebSearchResultItem[]`
- `WebSearchService` class with 5-min in-memory cache (normalized query key)
- Network errors not cached; empty results cached 30s
- Max 10 results, snippet max 150 chars

**New file: `src/main/web-search/BingHtmlSearchEngine.ts`**
- GET `https://www.bing.com/search?q=<query>` with proper Accept/Accept-Language headers
- Parse `#b_results > li.b_algo` using cheerio
- Extract title (h2>a aria-label fallback text), url (h2>a href), snippet (.b_caption p)
- Skip results without link or title
- Uses `getProxyAgent()` from existing httpsClient

**New file: `src/main/web-search/WebFetchService.ts`**
- SSRF protection: URL scheme check (http/https only), DNS resolve + private/loopback IP check
- Redirect following (max 5, each validated)
- 15s timeout, 2MB max body
- HTML parsing with cheerio: remove script/style/noscript/svg/iframe
- Prefer article > main > body
- Output: { url, title, content, truncated }
- Uses `getProxyAgent()` from existing httpsClient

### Phase 3: ToolRegistry

**New file: `src/main/tools/ToolRegistry.ts`**
- `OpenChatTool` interface: `definition` + `execute(args, context) → CanonicalToolResult`
- `ToolRegistry` class: register, getDefinitions(), getExecutor(), has()
- `ToolExecutionContext`: { signal?, conversationId?, segmentId? }

**New file: `src/main/tools/WebSearchTool.ts`**
- Definition: name=web_search, query parameter, description per spec
- Execute: calls WebSearchService.search(args.query), returns JSON with query + results array

**New file: `src/main/tools/WebFetchTool.ts`**
- Definition: name=web_fetch, url parameter, description per spec
- Execute: calls WebFetchService.fetch(args.url), returns JSON with url/title/content/truncated

### Phase 4: ChatCompletionsAdapter + ResponsesAdapter

**New file: `src/main/providers/ChatCompletionsAdapter.ts`**
- Implements `ModelAdapter`
- POST `{baseUrl}/chat/completions` with SSE streaming
- Converts CanonicalMessage[] → Chat Completions message format
- Converts OpenChatToolDefinition[] → `tools: [{ type: "function", function: {...} }]`
- Stream parsing: content delta, tool_calls delta accumulation (by index), finish_reason
- Tool result replay: assistant message with tool_calls + tool messages with role=tool
- Uses `getProxyAgent()` from httpsClient

**New file: `src/main/providers/ResponsesAdapter.ts`**
- Implements `ModelAdapter`
- POST `{baseUrl}/responses` with SSE streaming
- Converts CanonicalMessage[] → Responses input format
- Converts OpenChatToolDefinition[] → `tools: [{ type: "function", ... }]`
- Stream parsing: response.output_text.delta, response.function_call_arguments.delta/done
- Tool result replay: function_call + function_call_output items
- Stateless (no previous_response_id)
- Uses `getProxyAgent()` from httpsClient

**New file: `src/main/providers/ChatGPTCodexAdapter.ts`**
- Wraps existing `ChatGPTCodexClient` as `ModelAdapter`
- Converts CanonicalModelRequest to ProviderInputItem[] (ResponsesRequest format)
- Converts ResponsesSSEEvent to CanonicalModelEvent
- Translation of function_call events to canonical tool_call events

**New file: `src/main/providers/SSEParser.ts`**
- Generic SSE parser for both Chat Completions and Responses formats
- Handles `data:` lines, `data: [DONE]`, event-type lines

### Phase 5: ProtocolAgnosticToolLoopController

**New file: `src/main/tools/ToolLoopController.ts`**
- Constructor: `(modelAdapter: ModelAdapter, toolRegistry: ToolRegistry)`
- `run(request, signal, callbacks) → ToolLoopResult`
- Constants: MAX_TOOL_ROUNDS=4, MAX_WEB_SEARCH_CALLS=4, MAX_WEB_FETCH_CALLS=4
- Per-turn tracking: search call count, fetch call count, identical query dedup
- Flow: stream → collect text+tool_calls → execute tools → append results → continue
- Callbacks: onDelta, onToolCall, onToolResult, onReasoningStarted, onReasoningCompleted, onTurnStarted

### Phase 6: ProviderConfig persistence + IPC

**New file: `src/main/storage/ProviderConfigRepository.ts`**
- CRUD for provider_configs table
- `listSafe()` returns configs without apiKey (for renderer)
- `getById()` internal use only, returns full config with apiKey

**New file: `src/main/providers/ProviderConfigService.ts`**
- `listSafe()` → configs without apiKey
- `create(config)` → creates with generated id
- `delete(id)`, `update(id, updates)`
- `getAdapter(id)` → creates ChatCompletionsAdapter/ResponsesAdapter from config

**Modified: `src/shared/ipc/channels.ts`** — add PROVIDERS_LIST, PROVIDERS_CREATE, PROVIDERS_DELETE, PROVIDERS_UPDATE, CONVERSATIONS_UPDATE_PROVIDER

**Modified: `src/preload/index.ts`** — add `providers` API + `conversations.updateProviderConfig`

**Modified: `src/main/ipc/handlers.ts`** — register provider + update-provider handlers

**New file: `src/renderer/stores/providerStore.ts`** — Zustand store for provider configs

### Phase 7: Refactor ChatGPTConversationService

**Modified: `src/main/openai/chatgpt/ChatGPTConversationService.ts`**
- Accept ToolRegistry, WebSearchService, ProviderConfigService in constructor
- `resolveAdapter(conversation)` → ChatGPTCodexAdapter (default) or custom adapter
- `sendMessage()`:
  - If webSearchEnabled + supportsToolCalling → ToolLoopController with agentic mode
  - If webSearchEnabled + !supportsToolCalling → PreSearch mode
  - If !webSearchEnabled → direct model streaming
- PreSearch mode: search user query, inject search context as developer/system message
- Tool calling auto-detection: try with tools, if 400/422 "unsupported" → mark unsupported → fallback to PreSearch
- Search instructions injected when search enabled (per spec section 33)
- Emit web-search events for UI (tool_call name, query, results count)
- Save tool execution metadata to provider_payload_json

**Modified: `src/main/bootstrap/main.ts`**
- Create ToolRegistry, register web_search + web_fetch
- Create WebSearchService with BingHtmlSearchEngine
- Create ProviderConfigService + ProviderConfigRepository
- Wire into ChatGPTConversationService
- Initialize proxy config before creating services

### Phase 8: UI Updates

**New file: `src/renderer/components/settings/ProviderSettings.tsx`**
- List custom providers with name, protocol, baseUrl
- Add/Edit form with protocol dropdown, baseUrl, apiKey (password field), modelId, toolCalling toggle
- API key masked after initial save

**Modified: `src/renderer/components/settings/SettingsDialog.tsx`** — add ProviderSettings section

**Modified: `src/renderer/components/composer/WebSearchToggle.tsx`**
- Show for all providers (not just Codex models with webSearchToolType)
- Tooltip: agentic mode vs pre-search mode indicator

**Modified: `src/renderer/components/chat/AssistantMessage.tsx`**
- Show web search status indicator during streaming
- Show search results list after completion (collapsible, with source URLs)

## Key Design Decisions

1. **StreamEvent backward compatibility**: ChatGPTConversationService continues emitting the same StreamEvent type. Renderer (App.tsx, chatStreamStore) needs minimal changes.
2. **Codex search preserved**: ChatGPTCodexSearchClient remains but wrapped as ToolExecutor for Codex protocol. New providers use Bing search.
3. **Single AbortSignal**: One AbortController for model + search + fetch. User stop aborts everything.
4. **API key security**: Stored in local sql.js DB, never sent to renderer. listSafe() strips apiKey.
5. **Proxy**: All new network code uses getProxyAgent() from existing httpsClient.
6. **Cheerio 1.0.0-rc.12**: Exact version lock for Electron 22/Node 16 compatibility.

## Verification

1. `npx tsc --noEmit` — TypeScript type check
2. `npm run build` — full build
3. `npm run test` — existing tests
4. Manual test scenarios per spec section 59:
   - Chat Completions Compatible with function calling + search
   - Responses Compatible with function calling + search
   - Compatible API without tools → PreSearch mode
   - Search disabled → no tools injected
   - Search network failure → app doesn't crash
   - User stop → all aborted
   - web_fetch of 127.0.0.1 → rejected
   - Provider switch → history preserved, no cross-provider DTO replay
