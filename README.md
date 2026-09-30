# OpenChat

一个本地优先、轻量可控的桌面 AI 聊天客户端。

支持 **ChatGPT / Codex 账号登录、自定义 OpenAI 兼容 Provider、本地模型、联网搜索、推理模型、图片理解与图片生成**，所有会话、配置与附件均保存在本地。

> 一个面向多模型、多 Provider 和本地 AI 场景的桌面客户端，而不是简单的 ChatGPT Web 套壳。

<!-- 截图 1：OpenChat 主界面 -->
<!-- 建议展示：左侧会话列表 + 对话区域 + 模型选择 + Reasoning Level + 联网搜索 + 输入框 -->

<p align="center">
  <img src="https://github.com/user-attachments/assets/e2cfd74f-60eb-4520-b01d-9f4dbd1444c4" width="900" alt="OpenChat 主界面" />
</p>

---

## 功能特性

### ChatGPT / Codex

支持通过 ChatGPT 账号 OAuth 登录，无需单独配置 API Key。

- 动态获取当前账号可用模型
- 动态获取模型支持的推理等级
- 支持会话内切换模型
- 支持调整 Reasoning Level
- 支持查看 Codex 使用额度
- 支持流式响应

---

### 自定义 Provider

支持接入 OpenAI 兼容 API，无需等待 OpenChat 针对每个模型厂商单独适配。

支持：

- Chat Completions API
- Responses API
- Image Generation API
- 自定义 Base URL
- 自定义 API Key
- 自动获取模型列表
- 手动添加模型
- Provider / Model 动态请求参数

只要服务提供兼容的 OpenAI API，即可接入 OpenChat。

<!-- 截图 2：Provider 配置界面 -->
<!-- 建议展示：Provider 名称、API 类型、Base URL、API Key、模型列表、自定义参数 -->

<p align="center">
  <img src="https://github.com/user-attachments/assets/4be942fe-c0e2-4a4e-84ca-5b14bf4c2d37" width="820" alt="OpenChat Provider 配置" />
</p>

---

### 本地模型

本地模型同样通过 OpenAI 兼容接口接入。

例如：

```text
http://localhost:8000/v1
```

可用于连接：

- Ollama
- LM Studio
- vLLM
- llama.cpp
- MLX
- 其他 OpenAI Compatible Server

OpenChat 不绑定具体的本地模型运行框架。

---

### 联网搜索

可以直接在聊天输入框中开启联网搜索。

支持搜索引擎：

- Bing
- Google
- 百度

针对不同模型能力，OpenChat 支持多种搜索方式：

- Codex Hosted Search
- Standalone Search
- Tool Calling Search
- PreSearch

对于不支持 Tool Calling 的模型，也可以在请求模型前完成网页搜索并将结果加入上下文。

搜索结果支持来源展示与引用。

<!-- 截图 3：联网搜索实际效果 -->
<!-- 建议展示：联网搜索已开启 + AI 回答 + 搜索来源 + Citation/引用 -->

<p align="center">
  <img src="https://github.com/user-attachments/assets/e4a5dce0-d0bb-4777-9707-8d53668a8765" width="820" alt="OpenChat 联网搜索" />
</p>

---

### 图片理解

支持直接向模型发送图片。

图片可以通过以下方式添加：

- 选择文件
- 拖拽
- 剪贴板粘贴

支持单次添加多张图片。

对于支持 Vision 的模型，可以直接进行图片分析、问答和内容理解。

---

### 图片生成

OpenChat 提供独立的图片生成会话。

通过兼容 OpenAI Image API 的 Provider，可以进行：

- 文生图
- 图生图

生成结果支持：

- 图片预览
- 复制
- 保存到本地

<!-- 截图 4：图片生成会话 -->
<!-- 建议展示：Prompt + 图片生成结果 + 预览/复制/保存操作 -->

<p align="center">
  <img src="https://github.com/user-attachments/assets/cfad7e1e-94a8-4e57-8b51-ac5255bd7597" width="820" alt="OpenChat 图片生成" />
</p>

---

### 推理模型

支持 Reasoning / Thinking 模型。

根据模型能力，可以展示：

- 实时推理内容
- 推理摘要
- 推理耗时
- 推理等级

对于 ChatGPT / Codex，支持的推理等级会根据服务端模型信息动态加载。

---

### 会话管理

支持完整的本地会话管理：

- 新建会话
- 重命名
- 删除
- 会话历史
- 草稿自动保存
- 当前会话查找
- 跨会话全文搜索
- 搜索结果快速定位
- 命中内容高亮

<!-- 截图 5：跨会话全文搜索 -->
<!-- 建议展示：搜索结果列表 + 当前命中项 + 右侧消息定位 + 关键词高亮 -->

<p align="center">
  <img src="https://github.com/user-attachments/assets/885f4297-40b8-44bc-9d36-fd59984af7ca" width="820" alt="OpenChat 会话全文搜索" />
</p>

#### 上下文分段

OpenChat 使用 `Conversation → ContextSegment → Message` 的上下文结构。

你可以在一个会话中开启新的上下文段：

- 历史消息继续保留
- 新上下文不再携带旧段消息
- 修改 System Prompt 时可以开启新的上下文段

适合长期使用同一个会话，同时避免上下文持续膨胀。

---

## 本地优先

OpenChat 的核心数据保存在本地。

包括：

- 会话
- 消息
- Provider 配置
- 应用设置
- 图片附件
- 输入草稿

核心数据使用本地 SQLite 存储。

OpenChat 当前没有自己的云端会话同步服务，也未内置遥测系统。

聊天请求只会发送至你实际使用的 AI Provider，联网搜索请求会发送至对应的搜索服务。

---

## Provider 支持

| 类型 | 认证方式 | 自定义 Base URL | 自定义模型 |
| --- | --- | --- | --- |
| ChatGPT / Codex | OAuth | 否 | 服务端动态获取 |
| OpenAI Compatible Chat Completions | API Key | 是 | 是 |
| OpenAI Compatible Responses API | API Key | 是 | 是 |
| OpenAI Compatible Image API | API Key | 是 | 是 |

OpenChat 当前采用通用 OpenAI Compatible Provider 设计。

因此 DeepSeek、Qwen、GLM、OpenRouter、Ollama、LM Studio 等服务，只要提供兼容的 OpenAI API，都可以通过自定义 Provider 接入。

---

## 桌面体验

OpenChat 提供完整的桌面聊天体验，包括：

- 流式回复
- Markdown / GFM
- LaTeX
- 图片预览
- 文本复制
- 图片复制
- 浅色主题
- 深色主题
- 跟随系统主题
- 模型切换
- 推理等级切换
- 联网搜索切换
- 网络代理
- 会话全文搜索

---

## 快捷键

| 功能 | macOS | Windows / Linux |
| --- | --- | --- |
| 当前会话查找 | `⌘ F` | `Ctrl F` |
| 跨会话搜索 | `⌘ ⇧ F` | `Ctrl Shift F` |
| 开启新的上下文段 | `⌘ R` | `Ctrl R` |
| 停止生成 | `Esc` | `Esc` |

---

## 系统支持

OpenChat 支持：

- macOS
- Windows
- Linux

同时针对旧系统保留兼容能力，包括：

- macOS 10.13.6
- Windows 7

---

## 开发

建议使用 `npm` 管理依赖。

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm dev
```

### 运行测试

```bash
npm test
```

### 构建

```bash
npm build
```

更多构建命令请查看 `package.json` 中的 scripts。

---

## 技术栈

OpenChat 基于 Electron 构建，采用 Main / Preload / Renderer 桌面应用架构。

主要技术包括：

- Electron
- React
- TypeScript
- SQLite
- OpenAI Compatible APIs

Provider、模型、搜索、图片生成和本地数据均通过独立模块管理，以便扩展不同模型服务。

---

## 项目目标

OpenChat 希望提供一个：

**轻量、本地优先、支持多 Provider、多模型和本地 AI 的桌面聊天客户端。**

当前重点能力包括：

- AI 对话
- ChatGPT / Codex
- 自定义 Provider
- 本地模型
- Reasoning
- 联网搜索
- 图片理解
- 图片生成
- 会话搜索
- 本地数据管理