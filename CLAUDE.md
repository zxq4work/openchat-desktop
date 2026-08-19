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
1. Cmd/Ctrl+R = 新 ContextSegment = 新 Provider Thread
2. 系统提示变化 = 新 ContextSegment = 新 Provider Thread
3. 模型变化 = 不换 ContextSegment = 下一 Turn 覆盖 model
4. 推理强度变化 = 不换 ContextSegment = 下一 Turn 覆盖 effort

## 数据库
- 使用 sql.js (WASM SQLite)
- 数据库运行在 Main Process
- Renderer 不接触 DB 文件
- 流式阶段不每次 export 数据库
- turn completed 时强制持久化