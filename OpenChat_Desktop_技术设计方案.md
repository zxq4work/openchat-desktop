# OpenChat Desktop 技术设计方案

> **定位**：一个轻量级、Chatbox 风格的 ChatGPT Web 替代桌面客户端。  
> **目标系统**：Windows 7 SP1 x64、macOS 10.13.6 Intel x64。  
> **核心能力**：ChatGPT OAuth 登录、动态模型列表、动态推理强度、多会话、会话级系统提示/角色设定、流式文本对话、逻辑“新话题”上下文切断。  
> **文档协议基线日期**：2026-08-19。  
> **OpenAI 协议冻结版本**：OpenAI Codex `0.148.0` / tag `rust-v0.148.0` / commit `3ba0f71`。  
> **重要原则**：后续离线 Agent **不得自行猜测、升级或修改 OpenAI App Server RPC 字段**。

---

## 1. 产品目标

OpenChat Desktop 的第一阶段目标不是复制完整 ChatGPT Web，而是解决 ChatGPT Web 在旧机器、长对话和长期运行时较重、卡顿的问题，提供一个本地优先、界面简单、响应流畅的桌面聊天客户端。

第一阶段必须实现：

1. 使用 OpenAI 官方支持的 ChatGPT OAuth 登录。
2. 登录后通过官方 Codex App Server 获取当前账号可用模型。
3. 模型选择器必须动态展示模型，不允许硬编码模型名称。
4. 推理强度必须根据当前模型返回的 `supportedReasoningEfforts` 动态生成，不允许固定写 `low / medium / high`。
5. 模型选择器和推理强度选择器位于**消息输入框附近**，参考 Chatbox 的交互方式，而不是放在页面顶部作为全局配置。
6. 支持多个本地会话。
7. 每个会话独立保存：
   - 会话标题；
   - 系统提示 / 角色设定；
   - 当前选择模型；
   - 当前推理强度；
   - 聊天记录。
8. 支持流式回复。
9. 支持 Markdown、代码块、复制。
10. 支持停止生成。
11. 支持最后一轮重新生成。
12. `Cmd+R`（macOS）/ `Ctrl+R`（Windows）在当前会话中开始一个**逻辑新话题**：
    - 不删除屏幕上的旧消息；
    - 不创建新的左侧会话；
    - 旧消息仍然保存在本地；
    - 下一条消息开始使用全新的 OpenAI thread；
    - 上一段聊天上下文不再发送给模型。
13. 应用关闭、重启后恢复会话和消息。
14. 所有 Renderer 页面只加载本地资源，外部链接使用系统浏览器打开。

第一阶段暂不实现：

- 文件上传；
- 图片输入；
- 图片生成；
- Web Search；
- Voice；
- MCP；
- Plugins / Apps；
- Skills；
- Shell；
- 文件读写 Agent；
- Computer Use；
- ChatGPT Web 历史同步；
- 多账号；
- API Key 模式；
- 云同步。

---

# 2. 核心技术决策

## 2.1 技术栈

采用以下冻结基线：

| 层 | 技术 | 版本/策略 |
|---|---|---|
| 桌面容器 | Electron | **22.3.27** |
| 语言 | TypeScript | **5.4.5** |
| UI | React | **18.3.1** |
| React DOM | react-dom | **18.3.1** |
| 状态管理 | Zustand | **4.5.7** |
| 构建工具 | Vite | **4.5.x，package-lock 固定实际 patch** |
| 数据库 | sql.js | **1.10.3** |
| Markdown | markdown-it 或等价轻量实现 | 固定版本后写入 lockfile |
| 打包 | electron-builder | 选择与 Electron 22 验证通过的固定版本 |
| OpenAI 协议层 | Codex App Server | **0.148.0** |
| OpenAI transport | stdio JSONL | App Server 默认传输 |

### 为什么选择 React 18.3.1

React 18.3 是 React 官方为从 18.x 向 19 迁移准备的版本，其行为基本保持 React 18.2 的稳定模型，同时增加弃用警告。这个项目不需要 React 19 的 Server Components、Actions 等新能力。

本项目的目标环境是 Chromium 108 / Node 16 系列，优先选择成熟、依赖生态稳定、没有必要引入最新运行时特性的 React 18.3.1。

**禁止 Agent 自行升级 React 19。**

### 为什么选择 Zustand 4.5.7

本项目状态特点：

- 会话数量多，但同时只打开一个；
- 流式生成期间只有一个 Assistant Message 高频更新；
- 需要对单个 state slice 做 selector 订阅；
- 不需要 Redux 的 action/reducer 大型规范；
- 数据库才是持久化事实源，前端状态只负责当前 UI；
- 希望减少旧系统上的包体积和运行开销。

因此采用 Zustand，而不是 Redux Toolkit。

使用原则：

- Zustand 只存当前 UI/运行态；
- 不使用 Zustand `persist` 作为聊天记录持久化；
- 持久数据统一由 Main Process 的 Repository 层写数据库；
- 流式消息使用细粒度 selector，避免整个页面跟随每个 token 重渲染。

---

# 3. 为什么必须锁 Electron 22

目标系统同时要求：

- Windows 7 SP1；
- macOS 10.13.6。

Electron 22 是 Windows 7/8/8.1 的最后支持分支；Electron 23 开始要求 Windows 10。

因此：

```text
Electron major = 22
```

项目直接固定：

```json
{
  "electron": "22.3.27"
}
```

禁止：

```json
"electron": "^22.3.27"
```

更禁止：

```json
"electron": "latest"
```

项目根目录必须包含：

```text
COMPATIBILITY.md
```

内容明确写：

```text
HARD REQUIREMENT

Windows 7 SP1 x64 must remain supported.
macOS 10.13.6 Intel x64 must remain supported.

Electron MUST remain on 22.3.27 unless the product requirements change.

Do not upgrade Electron major.
```

---

# 4. OpenAI 集成总原则

## 4.1 不调用 ChatGPT Web 私有接口

禁止使用：

```text
chatgpt.com/backend-api/*
```

禁止：

- 抓 Cookie；
- 读取浏览器 ChatGPT 登录 Cookie；
- 复用 ChatGPT Web 私有 access token；
- 逆向 ChatGPT Web；
- 手工复制 ChatGPT OAuth client id；
- 自己实现未公开的 OAuth token exchange；
- 将 ChatGPT OAuth token 直接当 OpenAI REST API Key 使用。

第一阶段统一通过：

```text
OpenAI Codex App Server 0.148.0
```

完成：

```text
ChatGPT OAuth
Model Discovery
Thread Lifecycle
Turn Lifecycle
Streaming
Reasoning Effort
```

---

# 5. OpenAI 协议必须“冻结”，不能跟 latest

这是本方案最重要的工程约束之一。

由于开发 Agent 后续无法联网，项目不能依赖：

```text
“按 OpenAI 最新文档实现”
```

而应该依赖一个**固定协议快照**。

本项目固定：

```text
OpenAI Codex version: 0.148.0
tag: rust-v0.148.0
commit: 3ba0f71
release date: 2026-08-18
```

## 5.1 在进入离线开发前生成官方 Schema

使用**项目最终要捆绑的同一个 `codex` 0.148.0 二进制**执行：

```bash
codex app-server generate-ts --out ./vendor/openai/codex-0.148.0/schema-ts
```

以及：

```bash
codex app-server generate-json-schema --out ./vendor/openai/codex-0.148.0/schema-json
```

官方 App Server 文档明确规定：

> 生成的 TypeScript / JSON Schema 与执行命令的 Codex 版本对应。

因此 Agent 开发时：

```text
vendor/openai/codex-0.148.0/schema-ts
```

是协议类型的唯一事实源。

### 禁止 Agent：

- 手写整套 RPC interface；
- 根据网上旧文章猜字段；
- 根据本机其他版本 codex 的输出修改类型；
- 为了“修复 TS 报错”直接删字段；
- 使用 experimental API 替代 stable API。

---

# 6. OpenAI App Server 稳定 API 原则

初始化时：

**不要启用**：

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

第一阶段完全使用 stable API。

正确初始化：

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "openchat_desktop",
      "title": "OpenChat Desktop",
      "version": "0.1.0"
    }
  }
}
```

收到响应后发送 notification：

```json
{
  "method": "initialized",
  "params": {}
}
```

每次 App Server transport connection：

```text
只能 initialize 一次
```

初始化顺序：

```text
spawn app-server
       ↓
建立 stdin/stdout
       ↓
initialize
       ↓
initialized
       ↓
account/read
       ↓
其他 RPC
```

在 `initialize` 前发送业务 RPC 是错误实现。

---

# 7. App Server 进程模型

Electron Main Process 启动：

```bash
codex app-server
```

默认使用：

```text
stdin  -> JSONL request
stdout -> JSONL response / notification / server request
stderr -> App Server log
```

架构：

```text
┌───────────────────────────────────────────────┐
│ Electron Renderer                            │
│ React 18.3.1 + Zustand                       │
│                                               │
│  Sidebar          MessageList                │
│                     │                         │
│                     ▼                         │
│                 Composer                      │
│       Model / Effort / Role / Send           │
└─────────────────────┬─────────────────────────┘
                      │ IPC
┌─────────────────────▼─────────────────────────┐
│ Electron Main Process                         │
│                                               │
│ AuthService                                   │
│ ModelService                                  │
│ ConversationService                           │
│ ChatService                                   │
│ StorageService                                │
│ AppServerRpcClient                            │
└─────────────────────┬─────────────────────────┘
                      │ JSONL stdio
┌─────────────────────▼─────────────────────────┐
│ Codex App Server 0.148.0                      │
│ isolated CODEX_HOME                           │
└─────────────────────┬─────────────────────────┘
                      │ OpenAI managed protocol
                      ▼
                 OpenAI / ChatGPT
```

Renderer 永远不直接连接 OpenAI。

---

# 8. ChatGPT OAuth：冻结接口定义

## 8.1 查询登录状态

应用启动并 initialize 后调用：

```json
{
  "method": "account/read",
  "id": 10,
  "params": {
    "refreshToken": false
  }
}
```

ChatGPT 登录状态示例：

```json
{
  "id": 10,
  "result": {
    "account": {
      "type": "chatgpt",
      "email": "user@example.com",
      "planType": "plus"
    },
    "requiresOpenaiAuth": true
  }
}
```

注意：

```text
requiresOpenaiAuth = true
```

不等于“当前没有登录”。

真正判断应读取：

```text
result.account
```

如果：

```json
{
  "account": null
}
```

才进入登录 UI。

---

# 9. ChatGPT Browser OAuth

发送：

```json
{
  "method": "account/login/start",
  "id": 11,
  "params": {
    "type": "chatgpt",
    "useHostedLoginSuccessPage": true,
    "appBrand": "chatgpt"
  }
}
```

预期响应：

```json
{
  "id": 11,
  "result": {
    "type": "chatgpt",
    "loginId": "<uuid>",
    "authUrl": "https://chatgpt.com/..."
  }
}
```

Electron Main Process：

```ts
shell.openExternal(authUrl)
```

必须使用系统默认浏览器。

禁止：

```text
BrowserWindow(authUrl)
<webview>
iframe
```

App Server 自己负责本地 OAuth callback。

登录完成后监听：

```json
{
  "method": "account/login/completed",
  "params": {
    "loginId": "<uuid>",
    "success": true,
    "error": null
  }
}
```

随后通常收到：

```json
{
  "method": "account/updated",
  "params": {
    "authMode": "chatgpt",
    "planType": "plus"
  }
}
```

### 登录成功判定

不要只依赖 Browser 页面。

实际应用状态以：

```text
account/login/completed
+
account/read
```

为准。

登录完成后再次：

```json
{
  "method": "account/read",
  "id": 12,
  "params": {
    "refreshToken": false
  }
}
```

确认账号。

---

# 10. Device Code 登录作为备用方案

旧系统浏览器回调环境可能更脆弱，所以 MVP 同时支持 Device Code。

请求：

```json
{
  "method": "account/login/start",
  "id": 13,
  "params": {
    "type": "chatgptDeviceCode"
  }
}
```

响应：

```json
{
  "id": 13,
  "result": {
    "type": "chatgptDeviceCode",
    "loginId": "<uuid>",
    "verificationUrl": "https://auth.openai.com/codex/device",
    "userCode": "ABCD-1234"
  }
}
```

UI：

```text
使用设备验证码登录

验证码：
ABCD-1234

[复制验证码] [打开浏览器]
```

然后同样监听：

```text
account/login/completed
account/updated
```

---

# 11. 不使用 experimental token 模式

官方还存在：

```text
chatgptAuthTokens
```

但该模式属于 experimental API，并要求：

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

本项目**禁止使用**。

原因：

- 我们并不需要宿主自己管理 Token；
- App Server 的 managed ChatGPT OAuth 已负责 token 持久化和刷新；
- 离线 Agent 最不应该依赖实验字段。

---

# 12. 取消登录与退出

取消登录：

```json
{
  "method": "account/login/cancel",
  "id": 14,
  "params": {
    "loginId": "<uuid>"
  }
}
```

退出：

```json
{
  "method": "account/logout",
  "id": 15
}
```

成功：

```json
{
  "id": 15,
  "result": {}
}
```

随后监听：

```json
{
  "method": "account/updated",
  "params": {
    "authMode": null,
    "planType": null
  }
}
```

---

# 13. Token 管理原则

OpenChat Desktop 自己：

**不保存：**

- access token；
- refresh token；
- Authorization header；
- OAuth cookie。

由 App Server managed auth 负责。

Renderer 只允许获得：

```ts
type PublicAccountInfo = {
  loggedIn: boolean
  email: string | null
  planType: string | null
}
```

Renderer 绝不能拿 token。

---

# 14. 模型发现：禁止硬编码

登录完成后调用：

```json
{
  "method": "model/list",
  "id": 20,
  "params": {
    "limit": 20,
    "includeHidden": false
  }
}
```

官方响应核心结构：

```json
{
  "id": 20,
  "result": {
    "data": [
      {
        "id": "gpt-5.6-sol",
        "model": "gpt-5.6-sol",
        "displayName": "GPT-5.6-Sol",
        "hidden": false,
        "defaultReasoningEffort": "low",
        "supportedReasoningEfforts": [
          {
            "reasoningEffort": "low",
            "description": "Fast responses with lighter reasoning"
          }
        ],
        "inputModalities": ["text", "image"],
        "supportsPersonality": true,
        "isDefault": true
      }
    ],
    "nextCursor": null
  }
}
```

## 14.1 必须实现 cursor pagination

不要假设模型永远少于 `limit`。

逻辑：

```ts
let cursor: string | null = null
const result: ModelInfo[] = []

do {
  const page = await rpc.request('model/list', {
    limit: 20,
    includeHidden: false,
    ...(cursor ? { cursor } : {})
  })

  result.push(...page.data)
  cursor = page.nextCursor
} while (cursor)
```

---

# 15. 模型缓存结构

```ts
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
```

注意：

推理等级的 TypeScript 层不要写：

```ts
type ReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
```

客户端产品层应该视其为：

```ts
type ReasoningEffortId = string
```

并以：

```text
model.supportedReasoningEfforts
```

作为可选集合。

原因是推理等级是模型能力，不应该由客户端静态枚举限制。

---

# 16. 模型选择 UI

模型选择器必须靠近输入框。

推荐 Composer：

```text
┌──────────────────────────────────────────────────────┐
│ 输入消息……                                           │
│                                                      │
│                                                      │
│ [ GPT-5.6-Sol ▼ ] [ High ▼ ] [ ⚙ 角色设定 ]     [↑] │
└──────────────────────────────────────────────────────┘
```

生成中：

```text
┌──────────────────────────────────────────────────────┐
│                                                      │
│ [ GPT-5.6-Sol ▼ ] [ High ▼ ] [ ⚙ 角色设定 ]     [■] │
└──────────────────────────────────────────────────────┘
```

不要把模型选择做成顶部导航栏的全局状态。

---

# 17. 模型选择的会话语义

每个会话保存：

```text
default_model_id
default_reasoning_effort
```

这里“default”指：

> 当前会话下一条消息默认使用的配置。

用户在 Conversation A 选择：

```text
GPT-5.6-Sol / High
```

切到 Conversation B：

```text
GPT-5.6-Terra / Low
```

再切回 A：

```text
GPT-5.6-Sol / High
```

必须恢复 A 自己的配置。

---

# 18. 推理强度：核心功能

这是本项目的一级验收项。

模型切换时：

```ts
const supported =
  model.supportedReasoningEfforts
```

UI 必须只显示官方返回的选项。

例如：

```json
[
  {
    "reasoningEffort": "low",
    "description": "..."
  },
  {
    "reasoningEffort": "high",
    "description": "..."
  }
]
```

那么 UI 只能显示：

```text
Low
High
```

不得自己补：

```text
Medium
XHigh
```

---

# 19. 模型切换后的 effort 修正规则

假设当前：

```text
Model A
Effort = high
```

切换到 Model B。

如果 B 支持 `high`：

```text
继续 high
```

如果 B 不支持 `high`：

优先使用：

```text
Model B.defaultReasoningEffort
```

如果 default 不存在，再用：

```text
supportedReasoningEfforts[0]
```

伪代码：

```ts
function resolveEffort(
  model: ModelInfo,
  previous: string | null
): string | null {

  const supported =
    model.supportedReasoningEfforts.map(
      item => item.reasoningEffort
    )

  if (
    previous &&
    supported.includes(previous)
  ) {
    return previous
  }

  if (
    model.defaultReasoningEffort &&
    supported.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort
  }

  return supported[0] ?? null
}
```

---

# 20. 推理强度显示文案

内部值必须保留原始 ID。

例如：

```ts
const effortLabels: Record<string, string> = {
  none: '无',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: 'Ultra'
}
```

未知值：

```ts
return effortLabels[id] ?? id
```

不要因为客户端没有中文映射就隐藏新等级。

---

# 21. 发送 Turn 时传 model + effort

发送消息：

```json
{
  "method": "turn/start",
  "id": 40,
  "params": {
    "threadId": "thr_xxx",
    "input": [
      {
        "type": "text",
        "text": "用户消息"
      }
    ],
    "model": "gpt-5.6-sol",
    "effort": "high"
  }
}
```

`model` 和 `effort` 都取发送瞬间的 Conversation composer 配置。

如果当前模型没有 reasoning effort：

```text
不发送 effort 字段
```

不要：

```json
{
  "effort": null
}
```

除非生成 schema 明确允许并且代码有具体用途。

---

# 22. 每条 Assistant Message 记录实际配置

消息表保存：

```text
model_id
reasoning_effort
provider_turn_id
```

例如：

```text
Assistant

GPT-5.6-Sol · High
```

这样以后用户改变当前模型，历史消息仍显示实际生成配置。

---

# 23. 会话级系统提示 / 角色设定

每个 Conversation 有独立：

```text
system_prompt
system_prompt_revision
```

UI 叫：

```text
角色设定
```

设置窗口：

```text
┌──────────────────────────────────────────────┐
│ 角色设定                                     │
│                                              │
│ 系统提示                                     │
│ ┌──────────────────────────────────────────┐ │
│ │ 你是一名资深 Java 架构师……               │ │
│ │                                          │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│              [取消] [保存]                   │
└──────────────────────────────────────────────┘
```

角色按钮放在 Composer 模型选择旁：

```text
[GPT-5.6-Sol ▼] [High ▼] [⚙ 角色设定]
```

---

# 24. 系统提示的 OpenAI 实现

**禁止把系统提示伪装成用户消息：**

错误：

```json
{
  "input": [
    {
      "type": "text",
      "text": "System: 你是一名Java专家..."
    },
    {
      "type": "text",
      "text": "真正的用户问题"
    }
  ]
}
```

OpenAI Codex 0.148.0 的 stable `ThreadStartParams` 中包含：

```text
developer_instructions
```

该结构使用：

```text
serde(rename_all = "camelCase")
```

因此 JSON 字段为：

```text
developerInstructions
```

正确：

```json
{
  "method": "thread/start",
  "id": 30,
  "params": {
    "model": "gpt-5.6-sol",
    "approvalPolicy": "never",
    "sandbox": "readOnly",
    "serviceName": "openchat_desktop",
    "developerInstructions": "..."
  }
}
```

**不要使用 `baseInstructions` 存用户角色提示。**

用户可编辑的系统提示统一进入：

```text
developerInstructions
```

---

# 25. OpenChat 自己的固定 Chat 模式指令

Codex App Server 本质上源于 Codex，因此我们希望它在此应用中表现为文本对话助手，而不是代码 Agent。

生成 thread 时：

```ts
function buildDeveloperInstructions(
  conversationSystemPrompt: string
): string {

  const appMode = `
You are operating inside OpenChat Desktop as a general-purpose
text conversation assistant.

Respond directly to the user's conversational request.

Do not run commands, inspect local files, edit files, use tools,
start subagents, search the web, or interact with external apps.
This client intentionally provides text conversation only.
`.trim()

  const userRole = conversationSystemPrompt.trim()

  if (!userRole) {
    return appMode
  }

  return `${appMode}

<conversation_role_instructions>
${userRole}
</conversation_role_instructions>`
}
```

数据库只保存用户自己的：

```text
system_prompt
```

不要把 `appMode` 写进用户字段。

这样以后可独立升级固定指令。

---

# 26. System Prompt Snapshot

仅仅保存 Conversation 当前 system prompt 不够。

每个 Context Segment 必须保存：

```text
system_prompt_snapshot
system_prompt_revision
```

原因：

假设：

```text
消息 1-20
角色：Java专家
```

之后修改成：

```text
消息 21-
角色：英语老师
```

未来再次查看旧记录时，需要知道消息 1-20 当时真正使用的角色。

因此：

```text
Conversation
    当前 system_prompt

ContextSegment
    当时 system_prompt_snapshot
```

---

# 27. 修改角色设定后的上下文规则

如果当前 Segment 还没有发送任何用户消息：

```text
直接更新当前 Segment 的 system_prompt_snapshot
```

不创建边界。

如果当前 Segment 已经存在已发送消息：

保存新角色后：

```text
system_prompt_revision += 1
创建新的 ContextSegment
旧 Segment 保持不变
新的 provider_thread_id = NULL
```

UI 插入：

```text
────────── 角色设定已更新 ──────────
后续消息将使用新的角色设定和新的模型上下文
```

原因：

已有 OpenAI thread 已经携带旧 developerInstructions。

为了避免旧角色残留，角色改变后直接开启新的 provider thread，逻辑最明确，也最容易测试。

---

# 28. 多会话的数据模型

产品层必须区分：

```text
Conversation
ContextSegment
Provider Thread
Turn
Message
```

关系：

```text
Conversation
 ├── Segment 0
 │     └── providerThread A
 │          ├── Turn 1
 │          └── Turn 2
 │
 ├── Segment 1   ← Cmd/Ctrl+R
 │     └── providerThread B
 │
 └── Segment 2   ← 修改系统提示
       └── providerThread C
```

关键：

```text
Conversation != OpenAI Thread
```

一个本地 Conversation 可以对应多个 OpenAI thread。

---

# 29. Cmd+R / Ctrl+R：开始新话题

macOS：

```text
Cmd + R
```

Windows：

```text
Ctrl + R
```

语义：

```text
保留本地消息
+
当前 Conversation 不变
+
当前角色设定不变
+
当前模型选择不变
+
当前推理强度不变
+
创建新的 ContextSegment
+
下一条消息创建新的 OpenAI thread
```

UI：

```text
用户
上一段问题

助手
上一段回答


──────────── 新话题 ────────────
上方对话不会作为后续模型上下文


用户
新的问题
```

---

# 30. Cmd+R 后为什么必须换 Thread

如果继续使用原来的：

```text
threadId
```

即使 Renderer 不再重发旧消息，Provider thread 自身仍然包含历史。

因此真正的新话题必须：

```text
Segment 0 -> thread A
Cmd+R
Segment 1 -> thread B
```

断言：

```ts
segment0.providerThreadId
  !==
segment1.providerThreadId
```

---

# 31. Lazy Thread Creation

创建本地 Conversation 或 ContextSegment 时：

```text
provider_thread_id = NULL
```

不要立刻请求 OpenAI。

直到用户真正发送第一条消息：

```ts
async function ensureProviderThread(
  conversation: Conversation,
  segment: ContextSegment
): Promise<string> {

  if (segment.providerThreadId) {
    return segment.providerThreadId
  }

  const result = await appServer.threadStart({
    model: conversation.defaultModelId,
    approvalPolicy: 'never',
    sandbox: 'readOnly',
    serviceName: 'openchat_desktop',

    developerInstructions:
      buildDeveloperInstructions(
        segment.systemPromptSnapshot
      )
  })

  await segmentRepository.setProviderThreadId(
    segment.id,
    result.thread.id
  )

  return result.thread.id
}
```

---

# 32. thread/start 冻结用法

第一阶段只使用必要字段：

```json
{
  "method": "thread/start",
  "id": 30,
  "params": {
    "model": "gpt-5.6-sol",
    "approvalPolicy": "never",
    "sandbox": "readOnly",
    "serviceName": "openchat_desktop",
    "developerInstructions": "<generated>"
  }
}
```

不要传：

- cwd；
- dynamicTools；
- collaborationMode；
- historyMode；
- permissions；
- environments；
- projectId；
- experimentalRawEvents。

除非以后新需求明确需要。

---

# 33. thread/resume

本地已经有：

```text
provider_thread_id
```

应用重启后，在需要继续该 Segment 时调用：

```json
{
  "method": "thread/resume",
  "id": 31,
  "params": {
    "threadId": "thr_xxx"
  }
}
```

不建议每次应用启动就 resume 所有 thread。

只对当前即将继续聊天的 Segment lazy resume。

如果 resume 提示 thread 不存在：

第一阶段不要静默把所有旧消息重建进新 thread。

处理：

```text
1. 保留本地历史；
2. 显示“远端上下文不可恢复”；
3. 为下一条消息新建 ContextSegment；
4. 使用新 Thread；
5. 不丢本地历史。
```

---

# 34. 模型切换不创建新 Segment

模型和 effort 可以通过 `turn/start` 在 turn 级覆盖。

因此：

```text
切模型
≠
新话题
```

用户在同一 Segment：

```text
GPT-5.6-Sol
  ↓
GPT-5.6-Terra
```

继续使用原 thread。

发送下一条：

```json
{
  "method": "turn/start",
  "params": {
    "threadId": "原thread",
    "input": [...],
    "model": "新模型",
    "effort": "新等级"
  }
}
```

---

# 35. 发送消息完整流程

```text
用户 Enter
   ↓
检查当前 Conversation
   ↓
检查当前 ContextSegment
   ↓
ensureProviderThread()
   ↓
本地创建 UserMessage
   ↓
本地创建 pending AssistantMessage
   ↓
turn/start
   ↓
收到 turn id
   ↓
AssistantMessage.status = streaming
   ↓
item/agentMessage/delta
   ↓
批量刷新 UI
   ↓
item/completed
   ↓
turn/completed
   ↓
AssistantMessage.status = completed
   ↓
持久化最终内容
```

---

# 36. turn/start

请求：

```json
{
  "method": "turn/start",
  "id": 40,
  "params": {
    "threadId": "thr_123",
    "input": [
      {
        "type": "text",
        "text": "你好"
      }
    ],
    "model": "gpt-5.6-sol",
    "effort": "high"
  }
}
```

响应示意：

```json
{
  "id": 40,
  "result": {
    "turn": {
      "id": "turn_456",
      "status": "inProgress",
      "items": [],
      "error": null
    }
  }
}
```

保存：

```text
provider_turn_id = turn_456
```

---

# 37. 流式事件

MVP 重点处理：

```text
turn/started
item/started
item/agentMessage/delta
item/completed
turn/completed
error
```

文本增量：

```text
item/agentMessage/delta
```

`item/completed` 是 item 最终权威状态。

`turn/completed` 中 turn status 可能：

```text
completed
interrupted
failed
```

第一阶段不显示 raw reasoning。

可以忽略 UI 展示：

```text
item/reasoning/summaryTextDelta
item/reasoning/summaryPartAdded
item/reasoning/textDelta
```

**推理强度可选择，不代表必须展示模型思维过程。**

---

# 38. 停止生成

用户点：

```text
■
```

调用：

```json
{
  "method": "turn/interrupt",
  "id": 41,
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_456"
  }
}
```

成功：

```json
{
  "id": 41,
  "result": {}
}
```

最终收到：

```text
turn/completed
status = interrupted
```

本地 AssistantMessage：

```text
status = stopped
```

已经生成的文字保留。

---

# 39. 最后一轮重新生成

MVP 只支持：

```text
最后一个 User + Assistant pair
```

推荐实现方式：

第一版不要使用已经标记 deprecated 的 rollback API。

使用新的 ContextSegment：

```text
旧 segment 保留
        ↓
新 segment
        ↓
将需要保留的当前话题历史重新建立
```

但为了控制第一版复杂度，可以规定：

> “重新生成”只在当前最后一轮、且 turn 失败或被停止时重新发送。

对于已经 completed 的回答，第一阶段也可以实现为：

```text
创建分支 Segment
```

而不是篡改 Provider 历史。

本地 UI 可只显示最后一个有效 AssistantMessage。

详细分支/回溯属于第二阶段。

---

# 40. React UI 结构

```text
src/renderer/

  app/
    App.tsx
    router.tsx

  components/

    sidebar/
      Sidebar.tsx
      ConversationList.tsx
      ConversationItem.tsx
      NewConversationButton.tsx

    chat/
      ChatView.tsx
      MessageList.tsx
      MessageItem.tsx
      UserMessage.tsx
      AssistantMessage.tsx
      ContextBoundary.tsx

    composer/
      Composer.tsx
      MessageInput.tsx
      ModelSelector.tsx
      ReasoningSelector.tsx
      RoleSettingsButton.tsx
      SendButton.tsx
      StopButton.tsx

    settings/
      ConversationRoleDialog.tsx
      SettingsDialog.tsx
      AccountPanel.tsx

  stores/
    authStore.ts
    modelStore.ts
    conversationStore.ts
    chatStreamStore.ts
    uiStore.ts

  hooks/
  utils/
```

---

# 41. Zustand Store 设计

## authStore

只保存：

```ts
interface AuthState {
  status:
    | 'unknown'
    | 'logged-out'
    | 'logging-in'
    | 'logged-in'

  email: string | null
  planType: string | null
}
```

---

## modelStore

```ts
interface ModelState {
  models: ModelInfo[]
  loading: boolean
  lastUpdatedAt: number | null
  error: string | null
}
```

---

## conversationStore

只保存：

```ts
interface ConversationState {
  summaries: ConversationSummary[]
  activeConversationId: string | null

  activeConversation: Conversation | null
  activeMessages: Message[]
  activeSegments: ContextSegment[]
}
```

不要把所有 Conversation 的所有 messages 全部塞入 Zustand。

---

## chatStreamStore

只负责当前生成：

```ts
interface ChatStreamState {
  activeTurnId: string | null
  activeAssistantMessageId: string | null
  status:
    | 'idle'
    | 'starting'
    | 'streaming'
    | 'stopping'

  bufferedText: string
}
```

流式 delta 只通知当前 Message 相关组件。

---

## uiStore

```ts
interface UiState {
  sidebarCollapsed: boolean
  roleDialogOpen: boolean
  settingsDialogOpen: boolean
  modelPickerOpen: boolean
  effortPickerOpen: boolean
}
```

---

# 42. 避免 React 流式重渲染

错误：

```text
每收到一个 token
      ↓
更新整个 conversationStore
      ↓
MessageList 全量 render
      ↓
Markdown 全量 parse
```

正确：

```text
AppServer delta
     ↓
Main IPC buffer
     ↓
Renderer stream buffer
     ↓
约 30~50ms flush 一次
     ↓
只更新当前 AssistantMessage
```

建议：

```ts
const STREAM_FLUSH_MS = 40
```

Markdown：

- streaming 时降低完整解析频率；
- completed 时做一次最终完整 Markdown render；
- 长代码块不要每个 delta 高亮一次。

---

# 43. Message Component 必须 memo

```ts
export const MessageItem =
  React.memo(function MessageItem(props) {
    ...
  })
```

并确保 key：

```text
message.id
```

不是数组 index。

---

# 44. 输入框行为

```text
Enter
发送

Shift+Enter
换行

Esc
停止当前生成

Cmd/Ctrl+N
新建会话

Cmd/Ctrl+R
当前会话开始新话题

Cmd/Ctrl+,
设置
```

---

# 45. 禁止 Electron 默认刷新

`Cmd/Ctrl+R` 默认会触发 Chromium reload。

生产环境必须拦截：

```ts
webContents.on('before-input-event', (event, input) => {
  const isReloadShortcut =
    input.type === 'keyDown' &&
    input.key.toLowerCase() === 'r' &&
    (input.control || input.meta)

  if (isReloadShortcut) {
    event.preventDefault()

    mainWindow.webContents.send(
      'shortcut:new-topic'
    )
  }
})
```

生产菜单里不保留：

```text
Reload
Force Reload
Toggle DevTools
```

---

# 46. UI 参考布局

```text
┌─────────────────┬─────────────────────────────────────────────┐
│ + 新对话        │ 当前会话标题                                │
│                 │                                             │
│ 今天            │ 用户                                        │
│  会话 A         │ ...                                         │
│  会话 B         │                                             │
│                 │ Assistant                                   │
│ 昨天            │ ...                                         │
│  会话 C         │                                             │
│                 │                                             │
│                 │                                             │
│                 │ ┌─────────────────────────────────────────┐ │
│                 │ │ 输入消息……                              │ │
│                 │ │                                         │ │
│                 │ │                                         │ │
│                 │ │ [GPT-5.6-Sol▼] [High▼] [⚙角色]      [↑]│ │
│                 │ └─────────────────────────────────────────┘ │
│ ⚙ 设置          │                                             │
└─────────────────┴─────────────────────────────────────────────┘
```

目标风格：

- 类 Chatbox；
- 左侧列表；
- 主区干净；
- 不做 ChatGPT Web 的复杂顶部导航；
- 模型和推理等级紧邻输入区；
- 会话角色设置也从输入区附近进入。

---

# 47. Conversation 数据结构

```ts
export interface Conversation {
  id: string

  title: string

  systemPrompt: string
  systemPromptRevision: number

  defaultModelId: string | null
  defaultReasoningEffort: string | null

  currentSegmentId: string

  createdAt: number
  updatedAt: number
}
```

---

# 48. ContextSegment 数据结构

```ts
export type SegmentReason =
  | 'conversation-created'
  | 'new-topic'
  | 'system-prompt-changed'
  | 'provider-context-lost'

export interface ContextSegment {
  id: string
  conversationId: string

  sequence: number
  reason: SegmentReason

  providerThreadId: string | null

  systemPromptRevision: number
  systemPromptSnapshot: string

  createdAt: number
}
```

---

# 49. Message 数据结构

```ts
export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'stopped'
  | 'failed'

export interface Message {
  id: string

  conversationId: string
  segmentId: string

  role: 'user' | 'assistant'

  content: string
  status: MessageStatus

  modelId: string | null
  reasoningEffort: string | null

  providerTurnId: string | null
  providerItemId: string | null

  errorCode: string | null
  errorMessage: string | null

  createdAt: number
  updatedAt: number
}
```

---

# 50. 本地数据库方案

为了避开 Windows 7 + Electron Native Addon ABI 编译问题，MVP 不建议使用：

```text
better-sqlite3 native addon
node-sqlite3 native addon
```

优先：

```text
sql.js 1.10.3
```

即 WebAssembly SQLite。

优点：

- 无 node-gyp；
- 无 Electron native ABI；
- Win7 / macOS old runtime 更容易打包；
- schema 和 SQL 能继续使用 SQLite。

数据库只运行在 Main Process。

Renderer 不接触 DB 文件。

---

# 51. sql.js 持久化策略

数据库文件：

```text
<userData>/data/openchat.db
```

备份：

```text
openchat.db
openchat.db.tmp
openchat.db.bak
```

写入流程：

```text
BEGIN/业务更新
   ↓
sql.js 内存 DB 更新
   ↓
db.export()
   ↓
写 openchat.db.tmp
   ↓
fsync / close
   ↓
旧 main -> bak
   ↓
tmp -> main
```

不要在每一个 token delta 后 export 整个数据库。

流式阶段：

```text
Renderer 内存更新
+
每 1~2 秒 checkpoint（可选）
+
turn completed 时强制持久化
```

崩溃最多丢当前尚未 completed 的最后一小段流式文本，不丢已完成会话。

---

# 52. SQL Schema

```sql
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,

    title TEXT NOT NULL,

    system_prompt TEXT NOT NULL DEFAULT '',
    system_prompt_revision INTEGER NOT NULL DEFAULT 0,

    default_model_id TEXT,
    default_reasoning_effort TEXT,

    current_segment_id TEXT NOT NULL,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE context_segments (
    id TEXT PRIMARY KEY,

    conversation_id TEXT NOT NULL,

    sequence_no INTEGER NOT NULL,
    reason TEXT NOT NULL,

    provider_thread_id TEXT,

    system_prompt_revision INTEGER NOT NULL,
    system_prompt_snapshot TEXT NOT NULL,

    created_at INTEGER NOT NULL,

    FOREIGN KEY(conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_segments_conversation_seq
ON context_segments(conversation_id, sequence_no);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,

    conversation_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,

    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,

    model_id TEXT,
    reasoning_effort TEXT,

    provider_turn_id TEXT,
    provider_item_id TEXT,

    error_code TEXT,
    error_message TEXT,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    FOREIGN KEY(conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE,

    FOREIGN KEY(segment_id)
        REFERENCES context_segments(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation_created
ON messages(conversation_id, created_at);

CREATE INDEX idx_messages_segment_created
ON messages(segment_id, created_at);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE model_cache (
    model_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

---

# 53. Conversation 创建流程

点击：

```text
+ 新对话
```

Main：

```text
1. 读取全局默认模型
2. 读取全局默认 effort
3. 创建 Conversation
4. system_prompt = 全局默认角色（如有），否则空
5. system_prompt_revision = 0
6. 创建 Segment 0
7. Segment.provider_thread_id = NULL
8. 返回 Conversation
```

不会请求 OpenAI，直到第一次发送。

---

# 54. 会话标题

MVP 不额外调用模型生成标题。

第一条用户消息：

```text
trim
replace newline with space
最多取约 30~40 个字符
```

作为默认标题。

用户允许手动重命名。

---

# 55. 会话删除

本地删除时：

```text
1. 查所有 ContextSegment
2. 收集所有 provider_thread_id
3. 尝试 thread/delete
4. 不论远端清理是否成功，本地继续删除
5. 删除 Conversation
6. ON DELETE CASCADE 清理 segment/messages
```

Provider 清理失败写 WARN，不阻止用户本地删除。

---

# 56. App Server JSON-RPC Client

```text
src/main/openai/
  AppServerProcess.ts
  AppServerRpcClient.ts
  OpenAIProtocol.ts
  AuthService.ts
  ModelService.ts
  ThreadService.ts
  ChatService.ts
```

---

# 57. AppServerProcess 职责

只负责：

```text
start
stop
restart
health
stdout
stderr
exit
```

不要放：

```text
login
models
sendMessage
```

---

# 58. AppServerRpcClient 职责

负责：

- JSONL 编解码；
- 自增 request id；
- pending request Map；
- timeout；
- notification dispatch；
- server request dispatch；
- process crash 时 reject 所有 pending；
- JSON parse error 记录日志。

核心：

```ts
class AppServerRpcClient {
  private nextId = 1

  private pending =
    new Map<number, {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }>()

  request<T>(
    method: string,
    params?: unknown
  ): Promise<T>

  notify(
    method: string,
    params?: unknown
  ): void
}
```

---

# 59. 不允许使用 any 贯穿 OpenAI 协议

`JSON.parse()` 边界可以是：

```ts
unknown
```

然后使用：

```text
OpenAI 官方 generate-ts 生成类型
```

进行协议类型映射。

业务层定义少量 facade：

```ts
interface OpenAIModelFacade
interface OpenAIAccountFacade
interface OpenAITurnFacade
```

不要让 UI 直接依赖 100 个 generated protocol type。

---

# 60. IPC 边界

preload 只暴露：

```ts
window.openchat = {

  auth: {
    getStatus(),
    loginBrowser(),
    loginDeviceCode(),
    cancelLogin(),
    logout()
  },

  models: {
    list(),
    refresh()
  },

  conversations: {
    list(),
    get(),
    create(),
    rename(),
    remove(),

    updateRole(),
    updateModel(),
    updateEffort(),

    newTopic()
  },

  chat: {
    send(),
    interrupt(),
    regenerateLast()
  },

  events: {
    onAuthChanged(),
    onModelsChanged(),
    onChatDelta(),
    onTurnCompleted(),
    onChatError()
  }
}
```

---

# 61. Electron 安全设置

```ts
new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    preload
  }
})
```

Renderer 禁止：

```text
require()
fs
child_process
net
http
https
process.env
直接 spawn codex
```

---

# 62. 外部链接

所有：

```text
https://*
http://*
```

都禁止 Renderer 内部导航。

使用：

```ts
shell.openExternal(url)
```

```ts
webContents.setWindowOpenHandler(({ url }) => {
  if (
    url.startsWith('https://') ||
    url.startsWith('http://')
  ) {
    shell.openExternal(url)
  }

  return { action: 'deny' }
})
```

同时拦截：

```text
will-navigate
```

避免模型生成链接导致 Electron 22 内嵌浏览现代网站。

---

# 63. Chat-only Codex 配置

给 OpenChat 使用独立：

```text
CODEX_HOME
```

Windows：

```text
%APPDATA%\OpenChat\codex-home
```

macOS：

```text
~/Library/Application Support/OpenChat/codex-home
```

不能污染：

```text
~/.codex
```

---

# 64. config.toml

生成 OpenChat 专用：

```toml
forced_login_method = "chatgpt"

check_for_update_on_startup = false

web_search = "disabled"

file_opener = "none"

approval_policy = "never"

[features]
apps = false
goals = false
hooks = false
memories = false
multi_agent = false
shell_tool = false
skill_mcp_dependency_install = false
unified_exec = false

[tools]
view_image = false
web_search = false
```

解释：

- `forced_login_method = "chatgpt"`：只允许目标认证方式；
- `check_for_update_on_startup = false`：捆绑版本不自行升级，避免离线协议与二进制漂移；
- `web_search = "disabled"`：移除 web search tool；
- `apps = false`：关闭 app/connectors；
- `multi_agent = false`：关闭 subagent；
- `shell_tool = false`：关闭 shell；
- `unified_exec = false`：关闭 exec；
- `hooks = false`：不运行 hooks；
- `goals = false`：不启用 Codex goal 自动继续；
- `memories = false`：不使用 Codex memories；
- `view_image = false`：第一阶段纯文本。

另外：

```text
OpenChat CODEX_HOME
```

里不要配置：

```text
mcp_servers
skills
plugins
```

---

# 65. 为什么仍使用 sandbox readOnly

即便工具已关闭，创建 thread 时仍：

```json
{
  "approvalPolicy": "never",
  "sandbox": "readOnly"
}
```

作为防御性配置。

如果未来某个 Codex 行为变化意外暴露工具，也不要允许 workspace write。

---

# 66. OpenAI 错误映射

需要识别常见：

```text
ContextWindowExceeded
UsageLimitExceeded
HttpConnectionFailed
ResponseStreamConnectionFailed
ResponseStreamDisconnected
ResponseTooManyFailedAttempts
BadRequest
Unauthorized
SandboxError
InternalServerError
Other
```

UI：

```text
ContextWindowExceeded
→ 当前话题上下文过长，请使用 Cmd/Ctrl+R 开始新话题。

UsageLimitExceeded
→ 当前 ChatGPT 账号使用额度已达到限制。

Unauthorized
→ 登录已失效，请重新登录。

ResponseStreamDisconnected
→ 与 OpenAI 的连接中断，可以重新发送。

BadRequest
→ 当前模型或推理配置不可用，请刷新模型列表后重试。
```

日志保留原始 detail。

---

# 67. 模型列表更新失败

启动：

```text
先读取本地 model_cache
       ↓
UI可以快速展示最后缓存
       ↓
后台 model/list
```

如果刷新成功：

```text
replace cache
```

如果失败：

```text
继续显示缓存
+
显示“模型列表刷新失败”
```

但发送时如果 Provider 返回模型失效：

```text
强制 model/list
```

如果仍失败，再提示用户选择新模型。

---

# 68. 模型列表刷新时机

```text
App 启动并已登录
登录成功
用户手动刷新
Provider 返回 model-not-available 类错误
```

不要每次打开模型下拉都请求网络。

---

# 69. 长会话性能

ConversationList：

只读：

```text
id
title
updatedAt
preview
```

不要加载全部消息。

打开当前 Conversation：

```text
默认加载最近 100 条
```

向上滚动：

```text
再加载 100 条
```

---

# 70. Markdown 安全

必须：

```text
禁止原始 HTML
```

如果使用 markdown-it：

```ts
markdownIt({
  html: false,
  linkify: true,
  breaks: false
})
```

模型输出：

```html
<script>alert(1)</script>
```

只能作为文本/转义内容，不能执行。

---

# 71. 代码高亮

生成中：

```text
不要每 40ms 全量 syntax highlight
```

策略：

```text
streaming:
  plain/preformatted code

completed:
  final highlight
```

旧 Mac 性能会明显更好。

---

# 72. 日志

```text
<userData>/logs/main.log
<userData>/logs/app-server.log
```

示例：

```text
2026-08-19 09:00:00 INFO app-server.start version=0.148.0
2026-08-19 09:00:01 INFO app-server.initialize ok
2026-08-19 09:00:02 INFO auth.account type=chatgpt plan=plus
2026-08-19 09:00:03 INFO models.loaded count=7
2026-08-19 09:01:00 INFO thread.start conversation=... segment=...
2026-08-19 09:01:00 INFO turn.start model=... effort=...
2026-08-19 09:01:04 INFO turn.completed status=completed
```

禁止日志：

```text
access token
refresh token
Authorization
Cookie
完整 OAuth URL query 中的敏感参数
```

`authUrl` 默认也不要完整写日志。

---

# 73. Windows 7：真正的高风险点

Electron 22 可以运行 Win7。

真正风险是：

```text
Codex App Server 0.148.0
```

当前 Rust 默认：

```text
x86_64-pc-windows-msvc
```

目标要求 Windows 10+。

Rust 同时提供专门继续支持 Windows 7 的：

```text
x86_64-win7-windows-msvc
```

但该 target 属于 Tier 3。

因此：

> 不能假定官方 Codex Windows 二进制可以直接在 Win7 上运行。

---

# 74. Windows 7 Codex 构建方案

必须从固定源码：

```text
openai/codex
tag rust-v0.148.0
commit 3ba0f71
```

构建 Win7 兼容版。

目标：

```text
x86_64-win7-windows-msvc
```

实际构建可能需要：

```text
-Z build-std
```

或自建对应 target standard library。

这一步不要在 UI 开发完成后才尝试。

它必须是：

```text
M0 Blocker
```

---

# 75. Windows 7 M0 验收

真实：

```text
Windows 7 SP1 x64
```

必须完成：

```text
1. codex app-server 能启动
2. initialize 成功
3. account/read 成功
4. account/login/start(type=chatgpt) 成功
5. 系统浏览器 OAuth 成功
6. account/login/completed 成功
7. model/list 成功
8. 能看到 supportedReasoningEfforts
9. thread/start + developerInstructions 成功
10. turn/start + model + effort 成功
11. item/agentMessage/delta 能流式返回
12. turn/interrupt 成功
13. 程序退出重启后 managed login 可恢复
```

任一步失败：

```text
不得宣布 Win7 已支持
```

---

# 76. Windows 7 特别测试系统要求

最低测试：

```text
Windows 7 SP1 x64
```

并记录：

```text
是否安装 SHA-2 更新
是否安装 VC++ runtime
TLS 环境
系统默认浏览器
```

最终安装包应尽可能自带所需 runtime，避免依赖用户已有开发环境。

---

# 77. macOS 10.13.6

目标：

```text
x86_64-apple-darwin
```

Rust 官方 x86_64 macOS target 的最低运行版本低于 10.13，因此从 target 层面有可行空间。

Codex 构建时明确：

```bash
export MACOSX_DEPLOYMENT_TARGET=10.13
```

但同样必须实机验证 Codex 所有依赖没有偷偷提高最低系统版本。

---

# 78. macOS M0 验收

真实：

```text
macOS High Sierra 10.13.6
Intel
```

必须完成与 Win7 相同全链路：

```text
Electron
App Server
OAuth
model/list
thread/start
developerInstructions
turn/start
effort
stream
interrupt
重启恢复登录
```

---

# 79. 打包目录

Windows：

```text
OpenChat/
  OpenChat.exe
  resources/
    app.asar
    bin/
      codex.exe
    protocol/
      codex-0.148.0/
```

macOS：

```text
OpenChat.app/
  Contents/
    MacOS/
    Resources/
      app.asar
      bin/
        codex
      protocol/
        codex-0.148.0/
```

---

# 80. App Server 版本校验

应用启动后第一时间执行本地版本检查。

不要无脑运行用户 PATH 中的：

```text
codex
```

必须运行：

```text
process.resourcesPath/bin/codex
```

项目 manifest：

```json
{
  "codexVersion": "0.148.0",
  "tag": "rust-v0.148.0",
  "commit": "3ba0f71",
  "protocolSchemaVersion": "0.148.0"
}
```

如果 binary version 与 manifest 不一致：

```text
阻止 OpenAI 层启动
+
提示安装包损坏/版本不匹配
```

不要“尽量兼容”。

---

# 81. 为什么不自动升级 Codex

因为协议类型已被冻结。

如果 App 自己更新：

```text
0.148.0
→
0.160.0
```

但离线 Agent 编写的是：

```text
0.148.0 schema
```

可能出现：

```text
字段变化
行为变化
stable/experimental 状态变化
```

所以：

```text
check_for_update_on_startup = false
```

升级必须走显式迁移流程。

---

# 82. 将来升级 OpenAI App Server 的流程

只能：

```text
1. 确定新 stable release
2. 下载固定 tag source/binary
3. generate-ts
4. generate-json-schema
5. diff 新旧 schema
6. 更新 protocol adapter
7. 跑 contract tests
8. Win7 POC
9. macOS 10.13 POC
10. OAuth 实测
11. model/list 实测
12. reasoning effort 实测
13. 再更新 manifest
```

禁止直接：

```text
npm update
brew upgrade codex
codex self-update
```

---

# 83. 项目目录

```text
openchat-desktop/

├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vite.config.ts
├─ electron-builder.yml
├─ COMPATIBILITY.md
├─ OPENAI_PROTOCOL_BASELINE.md

├─ vendor/
│  └─ openai/
│     └─ codex-0.148.0/
│        ├─ manifest.json
│        ├─ schema-ts/
│        ├─ schema-json/
│        └─ protocol-examples.md
│
├─ src/
│
│  ├─ main/
│  │  ├─ bootstrap/
│  │  ├─ openai/
│  │  ├─ auth/
│  │  ├─ conversation/
│  │  ├─ storage/
│  │  ├─ ipc/
│  │  └─ security/
│  │
│  ├─ preload/
│  │  └─ index.ts
│  │
│  ├─ renderer/
│  │  ├─ app/
│  │  ├─ components/
│  │  ├─ stores/
│  │  ├─ hooks/
│  │  ├─ styles/
│  │  └─ utils/
│  │
│  └─ shared/
│     ├─ types/
│     ├─ constants/
│     └─ ipc/
│
├─ resources/
│  ├─ win/
│  │  └─ codex.exe
│  └─ mac/
│     └─ codex
│
└─ tests/
   ├─ unit/
   ├─ integration/
   ├─ protocol/
   └─ e2e/
```

---

# 84. Protocol Adapter

禁止业务代码到处写：

```ts
rpc.request('thread/start', ...)
```

统一：

```ts
class OpenAIAppServerClient {
  initialize()
  readAccount()
  loginChatGPT()
  loginDeviceCode()
  logout()

  listModels()

  startThread()
  resumeThread()
  deleteThread()

  startTurn()
  interruptTurn()
}
```

这样以后升级协议时只改 adapter。

---

# 85. Contract Test：初始化

必须测试：

```text
spawn mock/fixed app server
initialize
initialized
account/read
```

断言：

```text
initialize 只调用一次
业务请求不得早于 initialized
```

---

# 86. Contract Test：OAuth

固定 fixture：

```json
{
  "id": 11,
  "result": {
    "type": "chatgpt",
    "loginId": "login-1",
    "authUrl": "https://chatgpt.com/example"
  }
}
```

断言：

```text
Renderer 不收到 token
Main 调用 shell.openExternal
loginId 正确保存为 pending
account/login/completed 能切状态
```

---

# 87. Contract Test：模型与推理等级

fixture：

```json
{
  "data": [
    {
      "id": "model-A",
      "model": "model-A",
      "displayName": "Model A",
      "hidden": false,
      "defaultReasoningEffort": "low",
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "..."
        },
        {
          "reasoningEffort": "xhigh",
          "description": "..."
        }
      ],
      "isDefault": true
    }
  ],
  "nextCursor": null
}
```

断言 UI：

```text
Low
XHigh
```

不存在：

```text
Medium
High
```

选 XHigh 后：

```json
{
  "model": "model-A",
  "effort": "xhigh"
}
```

必须准确进入 `turn/start`。

---

# 88. Contract Test：系统提示

Conversation：

```text
systemPrompt =
“你是一名资深Java架构师”
```

第一次发消息前：

断言 `thread/start`：

```json
{
  "developerInstructions": "<固定chat指令> ... 你是一名资深Java架构师 ..."
}
```

同时断言：

```text
turn/start.input
```

中不存在：

```text
“你是一名资深Java架构师”
```

即：

> 角色设定不能伪装成 user message。

---

# 89. Contract Test：角色修改

初始：

```text
Segment 0
system prompt = A
thread = thread-A
```

已有消息后改成 B。

断言：

```text
Conversation.systemPromptRevision + 1
```

新建：

```text
Segment 1
systemPromptSnapshot = B
providerThreadId = null
```

下一条：

```text
thread-B != thread-A
```

`thread-B`：

```text
developerInstructions 包含 B
```

不得包含 A。

---

# 90. Contract Test：Cmd/Ctrl+R

初始：

```text
Conversation 1

Segment 0
thread A

User
Assistant
```

执行：

```text
newTopic()
```

断言：

```text
Conversation id 不变
messages 不删除
Segment 1 创建
Segment 1 providerThreadId = null
systemPromptSnapshot 与当前角色相同
```

下一条消息：

```text
thread B
```

断言：

```text
thread A != thread B
```

这是 Cmd/Ctrl+R 功能的真正验收，而不是只检查屏幕是否显示分割线。

---

# 91. UI 验收：模型位置

必须通过 UI screenshot / e2e 检查：

```text
ModelSelector
ReasoningSelector
RoleSettingsButton
```

都属于：

```text
Composer 区域
```

不得放到 ChatHeader 作为主要操作入口。

---

# 92. 状态与 DB 一致性原则

数据库：

```text
产品事实源
```

Zustand：

```text
当前 UI cache
```

App Server thread：

```text
Provider context
```

三者不能混淆。

定义：

```text
数据库回答：
“用户看到了什么”

ContextSegment + providerThread：
“模型当前记得什么”

Zustand：
“页面现在正在展示什么”
```

---

# 93. App Server crash

如果子进程异常退出：

```text
1. pending RPC 全部 reject
2. 当前 assistant message -> failed
3. 显示“OpenAI 服务进程异常退出”
4. 最多自动 restart 1 次
5. restart 后重新 initialize
6. account/read
7. 不自动重发用户消息
```

避免重复扣额度/重复回答。

---

# 94. 网络断开

不要自动无限重新提交 `turn/start`。

如果已经得到：

```text
turnId
```

但流断开：

```text
标记 failed/disconnected
```

由用户点击：

```text
重新生成
```

决定是否再次请求。

---

# 95. 并发规则

一个 Conversation 第一阶段只允许一个 active turn。

全应用可以简单限制：

```text
每个 Conversation <= 1 active turn
```

不同 Conversation 是否允许并发：

MVP 建议：

```text
全应用 <= 1 active generation
```

原因：

- UI 简单；
- Win7/老 Mac 资源有限；
- 防止用户切会话后忘记多路生成。

后续可放宽。

---

# 96. 输入期间切模型

如果当前正在生成：

模型下拉可允许修改：

```text
仅影响下一条消息
```

不能改变已经 active 的 Turn。

UI 可显示：

```text
本轮：GPT-5.6-Sol · High
下一轮：GPT-5.6-Terra · Low
```

但 MVP 不必显示第二行，只要不修改当前 message metadata。

---

# 97. 系统提示修改期间有 active turn

角色设置保存按钮：

如果正在生成：

```text
禁止保存
```

提示：

```text
请先停止当前回复，再修改角色设定。
```

避免在 turn 中途发生 context revision。

---

# 98. 数据清理

设置：

```text
清空全部聊天
```

必须二次确认。

操作：

```text
删除本地 Conversation DB
尝试 thread/delete
```

OAuth：

```text
不随聊天清空自动 logout
```

“退出登录”和“删除聊天数据”是两个独立动作。

---

# 99. 设置页面

MVP：

```text
账户
  email
  plan
  [退出登录]

默认聊天
  默认模型
  默认推理强度
  默认角色设定（可为空）

外观
  跟随系统
  浅色
  深色

数据
  打开数据目录
  清空聊天记录

关于
  OpenChat Desktop 0.1.0
  Electron 22.3.27
  Codex App Server 0.148.0
  Protocol 0.148.0
```

---

# 100. 第一阶段里程碑

## M0：协议和旧系统 POC

不写完整 UI。

实现最小 Node/Electron test harness：

```text
App Server start
initialize
account/read
OAuth
model/list
thread/start
developerInstructions
turn/start
model
effort
stream
interrupt
```

Win7 与 macOS 10.13.6 都通过。

---

## M1：Electron + React Shell

完成：

```text
Electron 22.3.27
React 18.3.1
Zustand 4.5.7
Vite 4.5.x
preload
IPC
Sidebar
ChatView
Composer
```

使用 mock provider。

---

## M2：本地数据

完成：

```text
sql.js
Conversation
Segment
Message
Settings
ModelCache
atomic save
```

---

## M3：认证

完成：

```text
account/read
browser OAuth
device-code
cancel
logout
restart restore
```

---

## M4：模型能力

完成：

```text
model/list pagination
model cache
model picker
supportedReasoningEfforts
effort picker
per-conversation settings
```

这是核心里程碑。

---

## M5：基础 Chat

完成：

```text
thread/start
thread/resume
turn/start
stream
stop
Markdown
copy
error
```

---

## M6：系统提示

完成：

```text
Conversation systemPrompt
developerInstructions
revision
segment snapshot
role change boundary
```

---

## M7：新话题

完成：

```text
Cmd/Ctrl+R interception
new ContextSegment
same local conversation
new provider thread
old UI history remains
```

---

## M8：性能与打包

完成：

```text
stream throttle
message pagination
Windows installer
macOS package
Win7 final test
macOS 10.13.6 final test
```

---

# 101. 一级验收清单

必须全部满足：

- [ ] Windows 7 SP1 x64 真机可启动。
- [ ] macOS 10.13.6 Intel 真机可启动。
- [ ] Electron 固定 22.3.27。
- [ ] React 固定 18.3.1。
- [ ] Zustand 固定 4.5.7。
- [ ] Codex App Server 固定 0.148.0。
- [ ] 不调用 ChatGPT Web 私有接口。
- [ ] 不使用 ChatGPT Cookie。
- [ ] Browser OAuth 使用 `account/login/start type=chatgpt`。
- [ ] Device Code 使用 `type=chatgptDeviceCode`。
- [ ] 不启用 `experimentalApi`。
- [ ] 使用官方生成 TS/JSON schema。
- [ ] `model/list` 动态获取模型。
- [ ] `model/list` 实现 pagination。
- [ ] 模型选择器在输入框附近。
- [ ] reasoning selector 在输入框附近。
- [ ] reasoning options 完全来自 `supportedReasoningEfforts`。
- [ ] `turn/start` 精确传入用户选择 model。
- [ ] `turn/start` 精确传入用户选择 effort。
- [ ] 每个 Conversation 保存自己的 model/effort。
- [ ] 每个 Conversation 有独立系统提示。
- [ ] 系统提示通过 `thread/start.developerInstructions` 发送。
- [ ] 系统提示不伪装成 user message。
- [ ] 系统提示修改后使用新 ContextSegment。
- [ ] Cmd/Ctrl+R 不删除本地历史。
- [ ] Cmd/Ctrl+R 创建新 ContextSegment。
- [ ] Cmd/Ctrl+R 后下一条使用全新 provider thread。
- [ ] Renderer 不读取 token。
- [ ] Renderer 不具有 Node 权限。
- [ ] 外部网页只在系统浏览器打开。
- [ ] shell / exec / web / apps / subagent 功能关闭。
- [ ] Streaming 不按单 token 全量 React render。
- [ ] Chat 历史以本地 DB 为事实源。
- [ ] App Server 使用独立 CODEX_HOME。
- [ ] Codex 不允许自行升级。

---

# 102. Agent 禁止事项

Agent 必须遵守：

```text
不要升级 Electron。
不要升级 React 到 19。
不要升级 Zustand major。
不要升级 Codex。
不要执行 codex latest 适配。
不要改用 chatgpt.com/backend-api。
不要抓 Cookie。
不要自己做 ChatGPT OAuth token exchange。
不要把 OAuth token 当 REST API key。
不要启用 experimentalApi。
不要硬编码模型。
不要硬编码推理等级。
不要把 system prompt 塞进 user message。
不要把一个 local Conversation 永久绑定一个 provider thread。
不要用 Ctrl/Cmd+R reload 页面。
不要启用 WebView 登录。
不要让 Renderer 直接访问 OpenAI。
不要让 Renderer 访问 fs/child_process。
不要启用 shell。
不要启用 MCP。
不要启用 apps/plugins。
不要启用 web search。
不要启用 subagent。
不要使用 native SQLite addon，除非另做 Win7 ABI POC。
不要为了修类型错误手工删除 generated protocol 字段。
```

---

# 103. 离线 Agent 开发前必须准备的材料

在 Agent 断网前，将以下内容放入项目：

```text
1. 本设计文档
2. Codex 0.148.0 固定源码或需要的 app-server 构建源码
3. Codex 0.148.0 可执行文件
4. generate-ts 输出
5. generate-json-schema 输出
6. package-lock.json
7. npm 依赖离线 cache / node_modules（按开发环境选择）
8. Windows 7 构建说明
9. macOS 10.13 构建说明
10. protocol fixtures
```

最关键：

```text
Agent 不需要访问 OpenAI 文档来“猜接口”。
```

它只应该依赖：

```text
vendor/openai/codex-0.148.0/schema-ts
```

---

# 104. OPENAI_PROTOCOL_BASELINE.md 应包含

项目额外创建：

```text
OPENAI_PROTOCOL_BASELINE.md
```

建议内容：

```text
OpenChat Desktop OpenAI protocol baseline

Codex: 0.148.0
Tag: rust-v0.148.0
Commit: 3ba0f71

Transport:
codex app-server over stdio JSONL

Experimental API:
DISABLED

Auth:
account/read
account/login/start type=chatgpt
account/login/start type=chatgptDeviceCode
account/login/cancel
account/logout

Models:
model/list

Threads:
thread/start
thread/resume
thread/delete

System Prompt:
ThreadStartParams.developerInstructions

Turns:
turn/start
turn/interrupt

Streaming:
turn/started
item/started
item/agentMessage/delta
item/completed
turn/completed
error

Generated schemas:
./vendor/openai/codex-0.148.0/schema-ts
./vendor/openai/codex-0.148.0/schema-json

DO NOT UPDATE WITHOUT PROTOCOL MIGRATION.
```

---

# 105. 最终架构原则

整套产品围绕四层建立：

```text
┌────────────────────────────┐
│ Conversation               │
│ 用户在左侧看到的长期会话    │
│ role/model/effort          │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│ ContextSegment             │
│ 一段有效模型上下文          │
│ prompt snapshot            │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│ Provider Thread            │
│ OpenAI App Server thread   │
└────────────┬───────────────┘
             │
             ▼
┌────────────────────────────┐
│ Turn                       │
│ user input                 │
│ model + effort             │
└────────────────────────────┘
```

其中：

```text
Cmd/Ctrl+R
=
新 ContextSegment
=
新 Provider Thread
```

```text
系统提示变化
=
新 system prompt revision
=
新 ContextSegment
=
新 Provider Thread
```

```text
模型变化
=
不换 ContextSegment
=
下一 Turn 覆盖 model
```

```text
推理强度变化
=
不换 ContextSegment
=
下一 Turn 覆盖 effort
```

这四条规则必须贯穿整个实现。

---

# 106. 给 Agent 的总任务描述

可以把下面内容作为 Agent 项目入口指令：

```text
你正在开发 OpenChat Desktop，一个轻量 ChatGPT 桌面客户端。

严格遵循项目内《OpenChat Desktop 技术设计方案》。

兼容目标：
Windows 7 SP1 x64；
macOS 10.13.6 Intel x64。

技术栈固定：
Electron 22.3.27；
TypeScript 5.4.5；
React 18.3.1；
Zustand 4.5.7；
Vite 4.5.x；
sql.js 1.10.3。

OpenAI 集成协议固定：
OpenAI Codex App Server 0.148.0，
tag rust-v0.148.0，
commit 3ba0f71。

不得联网猜协议。
不得升级 Codex。
不得调用 ChatGPT Web 私有 backend API。
不得抓 Cookie。
不得启用 experimentalApi。

OpenAI RPC 类型以：
vendor/openai/codex-0.148.0/schema-ts
和
vendor/openai/codex-0.148.0/schema-json
为唯一事实源。

认证使用官方 managed ChatGPT OAuth：
account/read；
account/login/start type=chatgpt；
account/login/start type=chatgptDeviceCode；
account/login/cancel；
account/logout。

模型通过 model/list 动态获取。
禁止硬编码模型名称。
必须处理 nextCursor pagination。

推理强度从每个模型的 supportedReasoningEfforts 动态生成。
禁止硬编码 low/medium/high。
发送 turn/start 时必须准确传递当前 model 和 effort。

每个本地 Conversation 独立保存：
系统提示/角色设定；
默认模型；
默认推理强度；
消息历史。

系统提示使用稳定 ThreadStartParams.developerInstructions，
不能伪装成用户消息。

一个本地 Conversation 可以拥有多个 ContextSegment。
一个 ContextSegment 对应一个 Provider Thread。

Cmd/Ctrl+R 开始新话题：
保留屏幕和数据库中的旧消息；
Conversation 不变；
创建新 ContextSegment；
下一条消息创建全新 Provider Thread；
旧 Segment 不能继续作为模型上下文。

修改系统提示：
若当前 Segment 已有消息，
创建新 ContextSegment，
新 Thread 使用新 developerInstructions。

模型和 effort 的切换不创建新 Segment，
只影响后续 turn/start。

模型与推理强度选择器必须位于消息输入框附近，
参考 Chatbox 交互。

Renderer：
nodeIntegration=false；
contextIsolation=true；
sandbox=true；
不能访问 token、fs、child_process 或 OpenAI。

App Server 使用 OpenChat 独立 CODEX_HOME。
关闭 shell、unified exec、web search、apps、multi-agent、
hooks、goals、memories、image tool。
thread/start 使用 approvalPolicy=never、sandbox=readOnly。

先做 M0：
必须在真实 Win7 SP1 x64 和 macOS 10.13.6 Intel 上，
完成 App Server、OAuth、model/list、developerInstructions、
turn/start model+effort、stream、interrupt 全链路 POC。

M0 未通过前，不得宣称目标系统兼容。
```

---

# 107. 上游依据快照

本方案的 OpenAI 字段基于以下**固定上游快照**整理，而不是基于第三方文章：

1. OpenAI Codex App Server 官方文档，2026-08-19 读取。
2. OpenAI `openai/codex` release `0.148.0`，tag `rust-v0.148.0`。
3. `rust-v0.148.0` 中 `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`：
   - `ThreadStartParams`；
   - `developer_instructions`；
   - `base_instructions`；
   - camelCase JSON serialization。
4. OpenAI Codex Configuration Reference：
   - `forced_login_method`；
   - `features.apps`；
   - `features.shell_tool`；
   - `features.unified_exec`；
   - `features.multi_agent`；
   - `features.memories`；
   - `web_search = "disabled"`；
   - `tools.view_image`。
5. Electron 官方 22.x release / support policy。
6. React 官方 React 18.3 说明。
7. Rust 官方 target support：
   - `x86_64-win7-windows-msvc`；
   - `x86_64-apple-darwin`。

如果未来升级任何一项上游版本，必须重新生成协议 Schema，并重新执行兼容性测试，不允许只修改版本号。
