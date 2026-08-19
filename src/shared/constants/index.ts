// 推理强度显示文案，内部值保留原始ID
export const EFFORT_LABELS: Record<string, string> = {
  none: '无',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: 'Ultra',
}

// 流式刷新间隔（毫秒）
export const STREAM_FLUSH_MS = 40

// 消息分页默认数量
export const MESSAGE_PAGE_SIZE = 100

// 会话标题最大字符数
export const TITLE_MAX_LENGTH = 40

// App Server 相关
export const CODEX_VERSION = '0.148.0'
export const CODEX_TAG = 'rust-v0.148.0'
export const CODEX_COMMIT = '3ba0f71'
export const APP_NAME = 'openchat_desktop'
export const APP_TITLE = 'OpenChat Desktop'