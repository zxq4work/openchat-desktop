# OpenChat Desktop 开发规范

## 技术栈固定版本
- Electron: 22.3.27
- React: 18.3.1
- Zustand: 4.5.7
- TypeScript: 5.4.5
- Vite: 4.5.x
- sql.js: 1.10.3
- Codex: 0.148.0

## 禁止事项
- 不要升级 Electron major
- 不要升级 React 到 19
- 不要升级 Codex 版本
- 不要硬编码模型名称
- 不要硬编码推理等级
- 不要把 system prompt 塞进 user message
- 不要用 Ctrl/Cmd+R reload 页面
- 不要启用 WebView 登录
- 不要让 Renderer 直接访问 OpenAI
- 不要让 Renderer 访问 fs/child_process
- 不要使用 native SQLite addon

## 核心数据模型
- Conversation: 本地会话
- ContextSegment: 上下文段（一个 Conversation 可有多个）
- Provider Thread: OpenAI 端 thread（一个 Segment 对应一个）
- Turn: 一次用户-助手交互

## 关键规则
1. Cmd/Ctrl+R = 新 ContextSegment = 新 Provider Thread（不是 reload 页面）
2. 系统提示变化 = 新 ContextSegment = 新 Provider Thread
3. 模型变化 = 不换 ContextSegment = 下一 Turn 覆盖 model
4. 推理强度变化 = 不换 ContextSegment = 下一 Turn 覆盖 effort

## 数据库
- 使用 sql.js (WASM SQLite)，运行时在 Main Process
- Renderer 不接触 DB 文件
- 流式阶段不每次 export 数据库，turn completed 时强制持久化
- 数据库文件路径: `userData/data/openchat.db`
- 保存策略: 先写 tmp → fsync → 旧文件 rename 为 .bak → tmp rename 为正式文件

## 项目结构

```
src/
├── shared/                    # 主进程和渲染进程共享
│   ├── types/
│   │   ├── conversation.ts    # Conversation, ContextSegment, Message, ReasoningMeta
│   │   ├── model.ts           # ModelInfo
│   │   └── account.ts         # PublicAccountInfo
│   ├── ipc/channels.ts        # IPC_CHANNELS 常量，主进程和 preload 各持有一份
│   └── constants/index.ts     # APP_NAME, TITLE_MAX_LENGTH, STREAM_FLUSH_MS=40
│
├── main/                      # 主进程
│   ├── bootstrap/main.ts      # 入口：初始化服务、注册IPC、创建窗口
│   ├── ipc/handlers.ts        # 所有 ipcMain.handle 注册 + 流式事件转发到 Renderer
│   ├── storage/
│   │   ├── StorageService.ts  # sql.js 封装（init/save/close/migrations）
│   │   ├── ConversationRepository.ts
│   │   ├── ContextSegmentRepository.ts
│   │   ├── MessageRepository.ts
│   │   ├── SettingsRepository.ts
│   │   ├── ModelCacheRepository.ts
│   │   └── ProviderConfigRepository.ts  # 自定义 Provider 配置持久化
│   ├── providers/              # 协议适配层（Chat Completions / Responses / Codex）
│   │   ├── ModelAdapter.ts     # 接口定义在 shared/types/provider.ts
│   │   ├── ChatCompletionsAdapter.ts  # /v1/chat/completions SSE
│   │   ├── ResponsesAdapter.ts        # /v1/responses SSE
│   │   ├── ChatGPTCodexAdapter.ts     # ChatGPT Codex 原生协议
│   │   ├── ProviderConfigService.ts   # Provider CRUD + Adapter 工厂
│   │   └── SSEParser.ts
│   ├── tools/                  # 工具系统（Agentic Tool Calling）
│   │   ├── ToolRegistry.ts     # 工具注册表
│   │   ├── ToolLoopController.ts  # 多轮 Tool Calling 循环
│   │   ├── WebSearchTool.ts    # web_search 工具定义 + 执行
│   │   └── WebFetchTool.ts     # web_fetch 工具定义 + 执行
│   ├── web-search/             # 搜索引擎
│   │   ├── WebSearchService.ts # 搜索缓存 + 结果清洗
│   │   └── BingHtmlSearchEngine.ts  # Bing HTML 爬取解析
│   ├── conversation/
│   │   └── ConversationService.ts  # AppServer 模式下的会话服务
│   └── openai/
│       ├── chatgpt/
│       │   ├── ChatGPTConversationService.ts  # 核心：会话CRUD + 流式生成
│       │   ├── ChatGPTSubscriptionProvider.ts
│       │   ├── auth/                         # OAuth 认证流程
│       │   ├── transport/
│       │   │   ├── ChatGPTCodexClient.ts     # HTTP/SSE 客户端
│       │   │   └── ResponsesStreamParser.ts  # SSE 事件解析
│       │   └── models/
│       │       └── ChatGPTModelService.ts    # 模型列表 + instructions 模板
│       ├── AuthService.ts / ModelService.ts / ThreadService.ts / ChatService.ts
│       └── AppServerProcess.ts / AppServerRpcClient.ts / OpenAIAppServerClient.ts
│
├── preload/
│   └── index.ts               # contextBridge 暴露 openchat API 到渲染进程
│
└── renderer/                  # 渲染进程
    ├── app/
    │   ├── main.tsx           # ReactDOM.createRoot
    │   └── App.tsx            # 根组件：初始化、流式事件监听、快捷键
    ├── stores/
    │   ├── conversationStore.ts  # 会话/消息/segment 状态
    │   ├── chatStreamStore.ts    # 流式状态（status/bufferedText/reasoning）
    │   ├── authStore.ts
    │   ├── modelStore.ts
    │   └── uiStore.ts           # 对话框/侧边栏/下拉菜单开关
    ├── components/
    │   ├── chat/
    │   │   ├── ChatView.tsx       # 聊天主视图（header + MessageList + Composer）
    │   │   ├── MessageList.tsx    # 消息列表，含滚动控制 + ResizeObserver
    │   │   ├── MessageItem.tsx    # 根据 role 分发 UserMessage/AssistantMessage
    │   │   ├── UserMessage.tsx
    │   │   ├── AssistantMessage.tsx  # 推理状态展示 + MarkdownRenderer
    │   │   └── ContextBoundary.tsx   # 新话题/角色更新 分割线
    │   ├── composer/
    │   │   ├── Composer.tsx         # 输入区域容器（含 .composer-inner 居中）
    │   │   ├── MessageInput.tsx     # textarea + 键盘事件（IME isComposing 处理）
    │   │   ├── ModelSelector.tsx
    │   │   ├── ReasoningSelector.tsx
    │   │   ├── SendButton.tsx
    │   │   └── RoleSettingsButton.tsx
    │   ├── settings/
    │   │   ├── SettingsDialog.tsx
    │   │   ├── AccountPanel.tsx
    │   │   ├── ConversationSettingsDialog.tsx  # 标题/角色/useModelInstructions
    │   │   └── ConversationRoleDialog.tsx
    │   ├── sidebar/
    │   │   ├── Sidebar.tsx
    │   │   ├── ConversationList.tsx
    │   │   └── ConversationItem.tsx
    │   └── MarkdownRenderer.tsx   # react-markdown + remark-gfm/math/breaks + rehype-katex
    ├── packages/
    │   ├── latex.ts            # processLaTeX: 状态机扫描器，标准化 \(/\[ 定界符
    │   └── latex.test.ts
    ├── styles/
    │   └── global.css
    └── vite-env.d.ts
```

## 架构要点

### 进程模型
- **Main Process**: 数据库、文件系统、OAuth 认证、HTTPS 请求、Codex SSE 流
- **Preload**: contextBridge 暴露 `window.openchat` API，禁止 Renderer 直接访问 Node API
- **Renderer**: React UI，通过 IPC invoke/on 与主进程通信

### 数据流
1. 用户输入 → Composer.handleSend → `window.openchat.chat.send(id, text)` (IPC invoke)
2. Main: ChatGPTConversationService.sendMessage → 创建 UserMessage + pending AssistantMessage
3. Main: runGeneration → ChatGPTCodexClient.sendResponses (SSE) → 逐事件处理
4. Main: onStreamEvent → ipc handlers → win.webContents.send (CHAT_DELTA/CHAT_REASONING_STARTED 等)
5. Renderer: App.tsx 监听事件 → chatStreamStore 更新 → AssistantMessage 增量渲染

### SSE 事件类型（ChatGPTCodexClient）
- `response.created` → 提取 providerTurnId
- `response.output_item.added` (type=reasoning) → 推理阶段开始
- `response.output_item.done` (type=reasoning) → 推理阶段结束，含 summary
- `response.output_text.delta` / `response.output_text.done` → 文本增量
- `response.reasoning_summary_text.delta` — **已移除处理**：之前错误地映射为 reasoning-started，导致计时器归零
- `response.completed` → 标记完成
- `error` → 错误处理

### 流式滚动机制（MessageList.tsx）
- 消息数/segment 数变化 → `scrollTop = scrollHeight` 滚动到底部
- 流式期间 → ResizeObserver 监听内容包裹层 (`contentRef`)，高度变化时自动滚动
- 注意：不能观察滚动容器本身（flex:1 高度固定），必须观察内部内容 div

### IME 输入处理（MessageInput.tsx）
- `e.nativeEvent.isComposing` 检测 IME 组合输入状态
- 组合中按 Enter 确认英文输入时，不触发发送

### Composer 布局
- `.composer` 全宽，`border-top` 分割线贯穿整个窗口
- `.composer-inner` max-width:800px + margin:0 auto 居中内容

### Dialog 关闭逻辑
- `ConversationSettingsDialog` 使用 `onMouseDown` + `e.target === e.currentTarget` 关闭 overlay
- 避免文本选择拖拽超出对话框时误触发关闭

## 待完成任务
- 实现 Markdown 流式渲染优化
- 验证 typecheck/build/test 全量通过
- Bing 搜索结果相关性排查：当前无 User-Agent 请求可能被 Bing 返回泛化/兜底结果，需验证实际返回的标题与查询关键词关联度

## Web Search 架构

### 三种搜索路径

```
用户消息 → webSearchEnabled?
  ├─ false → runGenerationDirect (无工具，直接流式生成)
  └─ true  → 检查 provider 能力缓存
       ├─ 已缓存为不支持 tools → PreSearch 模式
       └─ 未缓存/支持 tools → ToolLoop 模式
            ├─ 成功 → 模型自主决定是否调用 web_search
            └─ 抛出 unsupported_tools 错误 → 缓存 provider → PreSearch 回退
```

### ToolLoop 模式（Chat Completions + 支持 tools 的 Responses）

1. 在 system prompt 末尾追加 `SEARCH_INSTRUCTIONS`（`ChatGPTConversationService.ts:27-39`）
2. 请求携带 `tools: [web_search, web_fetch]` + `tool_choice: 'auto'`
3. `ToolLoopController` 多轮循环（最多 4 轮），每轮：
   - 流式消费模型输出，收集 `tool_call` 事件
   - 无 tool_call → 模型直接回答，退出循环
   - 有 tool_call → 执行工具，结果追加到 messages，下一轮
4. 模型**自主决定**是否调用 `web_search`，"刚刚搜索结果有什么" 不会触发搜索，"OpenAI最新新闻" 会触发

### PreSearch 模式（不支持 tools 的第三方 Responses API）

仅作为 **runtime capability detection 后的 fallback**，不是默认路径：

1. 模型提取搜索 query（`extractSearchQuery`，无 reasoning 的简短调用）
2. `BingHtmlSearchEngine` 执行搜索
3. 搜索结果注入上下文：
   - Responses 协议：作为 `developer` role message 注入
   - 其他协议：拼接到 system prompt 末尾
4. 注入语言强制模型声明搜索是它自己执行的，避免 "you provided the results"

### Runtime Capability Detection

- `providerToolsCapability` Map（`ChatGPTConversationService.ts:79`）缓存每个 provider 是否支持 function tools
- 首次请求带 tools，若返回不支持（`isToolsUnsupportedError` 检测），缓存为 `false`，后续直接走 PreSearch
- 检测条件：`unsupported_tools` 错误码、`<tool_call>` 原始文本输出、`web_search_call` 内置事件等

### 搜索结果处理

- 引擎：Bing HTML 爬取（`BingHtmlSearchEngine`），无 User-Agent
- 选择器：`#b_results > li.b_algo`，标题取 `h2 > a[aria-label]` 否则 `text()`
- 缓存：5 分钟 TTL（空结果 30 秒），key 为标准化后的 query
- 护栏：每轮最多 10 次 `web_search` + 10 次 `web_fetch`，相同 query 去重

### 流式阶段 `<tool_call>` 剥离

`runGenerationDirectStream` 内置状态机 sanitizer，跨 chunk 剥离 `<tool_call>...</tool_call>` 原始文本块。部分 Responses API 不支持 function calling，模型会输出 `<tool_call>` 原始 XML 而非 SSE 事件，剥离后避免显示给用户。

### 新增 IPC 事件

- `CHAT_WEB_SEARCH_STARTED` — 搜索开始（含 toolCallId/query）
- `CHAT_WEB_SEARCH_COMPLETED` — 搜索完成（含结果列表）
- `CHAT_WEB_SEARCH_ERROR` — 搜索失败
- `CHAT_STREAM_RESET` — ToolLoop 回退到 PreSearch 时清除渲染器缓冲文本

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/main/providers/` | 协议适配层（ChatCompletions / Responses / ChatGPTCodex） |
| `src/main/tools/` | ToolLoopController + 工具注册/执行 |
| `src/main/web-search/` | WebSearchService + BingHtmlSearchEngine |
| `src/shared/types/provider.ts` | ModelAdapter / CanonicalModelRequest / CanonicalModelEvent 等通用类型 |
| `src/renderer/stores/providerStore.ts` | Provider 前端状态 |
| `src/renderer/components/composer/ProviderSelector.tsx` | 模型提供商标识 |
| `src/renderer/components/settings/ProviderSettings.tsx` | Provider 配置 UI |

## 移除 Codex App Server 遗留代码（暂不执行）
当前 `chatgpt` 提供商是默认且唯一实际使用的路径。以下内容仅 `OPENCHAT_PROVIDER=appserver` 时才会被引用，属于遗留死代码，**在最终版本发布前提醒用户是否移除**（不要主动删除）：

- `src/main/openai/appserver-legacy/`（AppServer 实现：AppServerProcess / AppServerRpcClient / OpenAIAppServerClient / ThreadService / index.ts）
- `src/main/openai/` 根目录下的 shim 与 AppServer 服务：
  - `AppServerProcess.ts` / `AppServerRpcClient.ts` / `OpenAIAppServerClient.ts` / `ThreadService.ts`（`@deprecated` 一行 re-export）
  - `AuthService.ts` / `ModelService.ts` / `ChatService.ts`（依赖 OpenAIAppServerClient）
- `src/main/conversation/ConversationService.ts`（依赖 ThreadService + ChatService + ModelService，仅 appserver 路径使用）
- `src/main/openai/protocol-facade.ts`（零引用死代码，类型已被 `shared/types/` 替代）
- `vendor/openai/codex-0.148.0/`（约 2254 个文件，仅被上述代码引用）
- `src/shared/constants/index.ts` 中的 `CODEX_VERSION` / `CODEX_TAG` / `CODEX_COMMIT`（移除后仅剩 `APP_NAME` / `APP_TITLE`）
- `src/main/bootstrap/main.ts` 中的 `initializeAppServerProvider()` / `getAppServerMode()` / `getCodexBinaryPath()` / `getCodexHome()` / `getConfigPath()` 及相关 env 分支（`OPENCHAT_PROVIDER=appserver` / `OPENCHAT_APP_SERVER_MODE`）

## 验证命令（由用户执行）
沙箱模式下 Claude Code 无法执行 npm/npx 等命令（`npx tsc --noEmit`、`npm install`、`npm run dev` 等会被拒绝或无法运行）。改动完成后由 Claude 列出需要验证的命令，**由用户在终端自行执行**，并把输出结果粘贴回来。

常用验证命令：
- `npx tsc --noEmit` — TypeScript 类型检查（全量）
- `npm run build` — 完整构建
- `npm run test` 或 `npm test` — 运行 latex.test.ts 等测试
- `npm run dev` — 启动开发环境做功能验证