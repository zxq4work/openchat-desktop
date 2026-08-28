# OpenChat Desktop

轻量级 ChatGPT / Codex 桌面客户端，专注于 **长会话性能、老系统兼容、本地数据持久化，以及对模型、推理和搜索能力的完整控制**。

OpenChat Desktop 并不是 ChatGPT Web 的完整复刻，而是面向长期使用 AI 的开发者设计的一款桌面聊天客户端。

---

## Why OpenChat Desktop

OpenChat Desktop 最初源于一个很实际的问题：

> ChatGPT Web 在长时间、多轮对话场景下，页面可能逐渐变得卡顿，而传统第三方客户端又很难完整控制 OpenAI / Codex 的模型、推理等级、搜索模式和上下文行为。

因此，本项目希望提供一个：

* 更轻量、稳定的桌面聊天体验
* 更适合长时间、多会话使用的上下文模型
* 能直接控制 OpenAI / Codex 协议能力的客户端
* 本地保存完整聊天记录和配置的客户端
* 可以运行在 macOS 10.13.6 和 Windows 7 等老系统上的现代 AI 客户端

项目的目标不是堆叠功能，而是保持：

**简单、稳定、可控、本地优先。**

---

## Features

### Chat

* 流式 SSE 回复
* 推理过程与最终回答分离展示
* 推理耗时统计
* Markdown / GFM 渲染
* KaTeX 数学公式
* 代码语法高亮
* 停止生成
* 最后一轮重新生成
* 中文输入法 IME 支持

---

### Conversation & Context

OpenChat Desktop 并没有把一个会话简单地设计成无限增长的消息数组。

内部采用：

```text
Conversation
    └── ContextSegment
            └── Message
```

三级结构管理聊天上下文。

一个 Conversation 可以包含多个 ContextSegment。

通过：

```text
Cmd/Ctrl + R
```

可以在当前会话中开启一个新的逻辑话题。

旧消息：

* 仍然保留在聊天界面
* 仍然保存在本地数据库
* 但不会继续作为新话题的上下文发送给模型

每个 ContextSegment 对应独立的 Provider Thread，从而避免一个会话的上下文无限膨胀。

修改 System Prompt 时，如果当前会话已经存在历史消息，也会自动创建新的 ContextSegment。

---

### Models & Reasoning

模型能力尽量由服务端动态决定，而不是硬编码在客户端。

支持：

* 动态获取模型列表
* 本地 Model Cache
* 会话级模型切换
* 动态读取模型支持的 reasoning effort
* 会话级推理等级配置

推理等级由模型返回的：

```text
supportedReasoningEfforts
```

动态生成。

例如模型可能支持：

```text
minimal
low
medium
high
xhigh
max
ultra
```

客户端不会假设所有模型都拥有相同的推理等级。

模型列表会缓存在本地数据库中，在远端模型接口暂时不可用时仍可使用最近一次缓存结果。

---

## Search

Codex Provider 支持两种搜索模式。

| Mode       | 搜索执行位置       | 说明                       |
| ---------- | ------------ | ------------------------ |
| Hosted     | OpenAI 服务端   | 使用 Codex 原生 `web_search` |
| Standalone | OpenChat 客户端 | 使用 `web.run` 在客户端执行搜索    |

### Hosted

Hosted 模式下，搜索由 Codex 服务端执行。

```text
User
  ↓
OpenChat
  ↓
Codex
  ↓
web_search
  ↓
Search Result
```

搜索结果通过 Codex SSE 事件返回。

这种模式更接近 Codex 原生搜索行为。

### Standalone

Standalone 模式下，搜索工具由 OpenChat Desktop 提供：

```text
User
  ↓
Codex requests web.run
  ↓
OpenChat Desktop
  ↓
Search
  ↓
Result returned to Codex
```

客户端通过 Codex Search API 完成搜索，然后将结果继续交给模型。

---

### Custom Provider Search

自定义 Provider 可以使用 OpenChat 自己的搜索工具：

```text
openchat_web_search
```

目前支持：

* Bing
* Baidu
* Google

对于支持 Tool Calling 的模型，会通过 Tool Loop 执行搜索。

对于不支持 Tool Calling 的第三方模型，会自动回退到 PreSearch：

```text
用户问题
   ↓
提取搜索关键词
   ↓
执行搜索
   ↓
将搜索结果注入上下文
   ↓
模型生成答案
```

---

## Authentication

OpenChat Desktop 支持 ChatGPT OAuth 登录。

认证流程采用：

```text
OAuth 2.0
+
PKCE S256
```

授权回调由本地服务接收：

```text
http://localhost:1455
```

认证模块支持：

* OAuth 2.0 + PKCE
* Token 自动刷新
* Token 提前刷新
* 401 自动重试
* Device Code 登录
* HTTP Proxy
* SOCKS5 Proxy
* 系统代理检测

所有认证凭证只存在于 Electron Main Process。

Renderer 无法直接访问 Token。

---

## Custom Provider

除了 ChatGPT / Codex Provider，OpenChat Desktop 还支持自定义模型服务。

支持：

### Chat Completions API

```text
/v1/chat/completions
```

### Responses API

```text
/v1/responses
```

自定义 Provider 可以配置：

* Base URL
* API Key
* 模型列表
* `/models` 自动获取
* 手动模型配置
* Tool Calling
* 自定义请求路径
* 自定义 HTTP Header

API Key 只会存储和使用在 Main Process 中。

---

## Architecture

OpenChat Desktop 使用 Electron 标准的：

```text
Renderer
Preload
Main
```

三层结构。

```text
┌───────────────────────────────────────────────────┐
│                    Renderer                       │
│                                                   │
│ React 18                                          │
│ Zustand                                           │
│ Chat / Composer / Sidebar / Settings              │
│                                                   │
└──────────────────────┬────────────────────────────┘
                       │
                window.openchat
                       │
┌──────────────────────▼────────────────────────────┐
│                     Preload                        │
│                                                   │
│ contextBridge                                     │
│ IPC invoke / event                                │
│                                                   │
└──────────────────────┬────────────────────────────┘
                       │
                      IPC
                       │
┌──────────────────────▼────────────────────────────┐
│                      Main                          │
│                                                   │
│ Conversation Service                              │
│ Model Service                                     │
│ Authentication                                    │
│ Search / Tool Loop                                │
│ Provider Config                                   │
│                                                   │
│                ModelAdapter                       │
│          ┌──────────┼──────────┐                  │
│          ↓          ↓          ↓                  │
│       Codex      Chat API    Responses            │
│                                                   │
│ StorageService / sql.js                           │
│                                                   │
└──────────────┬─────────────────────┬──────────────┘
               │                     │
               ↓                     ↓
         Local SQLite            OpenAI /
                                 Custom API /
                                 Search Engine
```

Renderer 不直接：

* 访问数据库
* 管理 Token
* 保存 API Key
* 访问本地文件系统
* 调用 OpenAI 网络接口

所有敏感能力均由 Main Process 管理。

---

## Protocol Layer

不同模型协议通过统一的：

```text
ModelAdapter
```

进行抽象。

当前主要包括：

### ChatGPTCodexAdapter

对接 ChatGPT Codex 原生协议。

支持：

* reasoning
* SSE streaming
* `web_search_call`
* `function_call`
* Codex Search
* Tool Calling

### ChatCompletionsAdapter

对接标准：

```text
/v1/chat/completions
```

API。

### ResponsesAdapter

对接：

```text
/v1/responses
```

API。

所有 Adapter 最终转换为统一事件：

```text
CanonicalModelEvent
```

因此上层 Conversation Service 和 Renderer 不需要理解不同 Provider 的底层协议差异。

---

## Data Flow

一次普通聊天请求大致经过：

```text
Composer
   ↓
window.openchat.chat.send()
   ↓
IPC
   ↓
Main Process
   ↓
ChatGPTConversationService
   ↓
Search Strategy
   ↓
ModelAdapter
   ↓
HTTP / SSE
   ↓
CanonicalModelEvent
   ↓
IPC Stream Events
   ↓
Zustand
   ↓
AssistantMessage
```

流式阶段由 Main Process 持续通过 IPC 向 Renderer 推送增量事件。

---

## Local Storage

OpenChat Desktop 使用：

```text
sql.js
```

作为本地数据库。

sql.js 基于 WASM SQLite，无需安装 native addon，对 Windows 7 和旧版 macOS 更友好。

主要保存：

* Conversations
* ContextSegments
* Messages
* Settings
* Model Cache
* Provider Configs

---

### 数据安全保存

数据库保存采用：

```text
openchat.db
   ↓
openchat.db.tmp
   ↓
fsync
   ↓
旧数据库 → .bak
   ↓
.tmp → openchat.db
```

降低应用异常退出导致数据库损坏的概率。

同时支持运行时 Schema 增量迁移。

---

### 数据位置

macOS：

```text
~/Library/Application Support/openchat_desktop/data/openchat.db
```

Windows：

```text
%APPDATA%/openchat_desktop/data/openchat.db
```

---

## Project Structure

核心源码结构：

```text
src/

├── shared/
│   ├── types/
│   ├── ipc/
│   └── constants/
│
├── main/
│   │
│   ├── bootstrap/
│   │
│   ├── ipc/
│   │
│   ├── storage/
│   │
│   ├── providers/
│   │
│   ├── tools/
│   │
│   ├── web-search/
│   │
│   ├── conversation/
│   │
│   └── openai/
│       │
│       ├── chatgpt/
│       │   ├── auth/
│       │   ├── transport/
│       │   ├── models/
│       │   ├── search/
│       │   ├── tools/
│       │   └── usage/
│       │
│       └── appserver-legacy/
│
├── preload/
│
└── renderer/
    ├── app/
    ├── stores/
    ├── packages/
    └── components/
        ├── chat/
        ├── composer/
        ├── settings/
        └── sidebar/
```

---

## Core Concepts

### Conversation

Conversation 是用户看到的顶级会话。

包含：

* 标题
* System Prompt
* 默认模型
* reasoning effort
* 搜索配置
* 当前 ContextSegment

---

### ContextSegment

ContextSegment 是一个 Conversation 内部的独立上下文段。

创建以下行为时可能产生新的 Segment：

```text
创建 Conversation
Cmd/Ctrl + R
修改 System Prompt
```

切换 Segment 不会删除历史消息。

它只是切断发送给模型的上下文。

---

### Message

Message 属于某一个 ContextSegment。

主要保存：

* role
* content
* reasoning
* reasoning duration
* web search results
* generation status
* model
* reasoning effort

生成状态包括：

```text
pending
streaming
completed
stopped
failed
```

---

## Desktop Shortcuts

| Shortcut       | Action    |
| -------------- | --------- |
| `Cmd/Ctrl + N` | 创建新会话     |
| `Cmd/Ctrl + R` | 当前会话开启新话题 |

外部链接默认通过系统浏览器打开。

应用关闭时会自动保存当前草稿。

---

## Compatibility

老系统兼容是 OpenChat Desktop 的核心设计约束，而不是临时兼容方案。

必须支持：

```text
macOS 10.13.6 High Sierra Intel x64
Windows 7 SP1 x64
```

因此项目不会为了追求最新版本而随意升级 Electron 或基础依赖。

### Electron

当前：

```text
Electron 22.3.27
```

Electron 22 是仍支持 macOS 10.13 的最后一个 Electron Major 版本之一。

因此：

> 不应直接升级 Electron Major。

任何 Electron 升级都必须首先验证：

```text
macOS 10.13.6
Windows 7 SP1
```

兼容性。

---

### Runtime

当前主要运行环境：

```text
Electron 22.3.27
Chromium 108
Node.js 16
React 18
```

项目代码不能默认使用只有新版 Node.js 或 Chromium 才支持的 API。

---

### Why sql.js?

选择 sql.js 而不是 SQLite native addon，是为了避免：

* node-gyp
* native module ABI
* Windows 7 编译问题
* macOS 旧系统二进制兼容问题
* Electron ABI 重新编译

从而降低跨平台构建复杂度。

---

## Development

### Requirements

推荐：

```text
Node.js 16.x
npm 8.x+
```

---

### Install

```bash
npm install
```

---

### Development

```bash
npm run dev
```

开发流程大致为：

```text
Compile Main Process
       ↓
Start Vite
       ↓
Start Electron
```

---

### Type Check

```bash
npx tsc --noEmit
```

---

### Test

```bash
npm test
```

---

### Build

```bash
npm run build
```

---

## Packaging

### macOS

```bash
npm run package:mac
```

---

### Windows

完整 Windows 构建：

```bash
npm run package:win
```

NSIS：

```bash
npm run package:win:nsis
```

Portable：

```bash
npm run package:win:portable
```

ZIP：

```bash
npm run package:win:zip
```

---

### Current Platform

```bash
npm run package
```

---

## Cross-platform Build

支持：

```text
macOS → macOS
Windows → Windows
```

在旧版 macOS 环境下构建 Windows Portable 时，项目提供专门的兼容构建流程：

```text
package:win:portable:legacy-mac
```

对应：

```text
scripts/package-win-portable-legacy-mac.js
```

构建产物输出：

```text
release/
```

---

## Configuration

### Provider Mode

```text
OPENCHAT_PROVIDER
```

默认：

```text
chatgpt
```

---

### Mock Provider

```text
OPENCHAT_PROVIDER_MOCK
```

默认：

```text
false
```

---

### AppServer

```text
OPENCHAT_APP_SERVER_MODE
```

开发环境和生产环境可能分别使用：

```text
mock
bundled
```

AppServer 当前属于 Legacy Provider 路径。

---

## Proxy

支持：

* HTTP
* HTTPS
* SOCKS5
* System Proxy

系统代理支持自动读取 macOS / Windows 当前代理设置。

代理配置可以通过 Settings 管理并保存到本地数据库。

---

## Design Principles

### Local First

聊天历史、设置和 Provider 配置尽可能保存在本地。

---

### Main Process as Trust Boundary

Renderer 不持有：

```text
OAuth Token
API Key
Database
File System Access
```

Main Process 是应用主要安全边界。

---

### Protocol Independent UI

Renderer 不关心底层使用：

```text
Codex
Chat Completions
Responses
```

这些差异全部由 ModelAdapter 层处理。

---

### Dynamic Model Capability

模型名称和 reasoning effort 尽可能从远端能力动态获取。

避免因为服务端新增模型而频繁更新客户端。

---

### Compatibility First

依赖升级优先考虑：

```text
Compatibility
Stability
Maintainability
```

而不是单纯追求最新版本。

---

## Legacy AppServer

项目仍保留早期 AppServer Provider：

```text
src/main/openai/appserver-legacy/
```

可通过：

```text
OPENCHAT_PROVIDER=appserver
```

启用。

该模式通过 stdio JSONL RPC 与 Codex AppServer 通信。

目前默认 Provider 已切换到直接 ChatGPT / Codex 协议实现，因此 AppServer 主要作为遗留兼容路径保留。

---

## Current Scope

OpenChat Desktop 当前主要关注：

* 文本聊天
* Reasoning
* Web Search
* Conversation Management
* OpenAI / Codex
* Custom Provider
* Local Storage
* Desktop Client

以下能力暂不属于当前核心范围：

* 文件上传
* 图片输入
* 图片生成
* MCP
* Plugins
* Skills
* Shell
* Computer Use
* ChatGPT Web 历史记录同步
* 多账号
* 云同步

---

## License

License has not been specified yet.
