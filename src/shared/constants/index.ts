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

// 会话标题最大字符数
export const TITLE_MAX_LENGTH = 40

// 单条消息图片数量上限（Renderer 预校验与 Main 落库共用同一来源）
export const MAX_IMAGES_PER_MESSAGE = 6

// App Server 相关
export const CODEX_VERSION = '0.148.0'
export const CODEX_TAG = 'rust-v0.148.0'
export const CODEX_COMMIT = '3ba0f71'
export const APP_NAME = 'openchat_desktop'
export const APP_TITLE = 'OpenChat Desktop'

// Splash 视觉时长（从 MainWindow 真正 show 开始计时）
// 快速启动时 Splash 目标总视觉时长（含淡出），避免"一闪而过"
export const MIN_SPLASH_TOTAL_VISIBLE_MS = 350
// 淡出动画时长。保持与 renderer CSS transition 一致（index.html #boot-splash）
export const SPLASH_FADE_MS = 130
// Splash DOM 清理 fallback 超时（fade 时长 + 安全余量），用于 transitionend 未触发时
export const SPLASH_CLEANUP_TIMEOUT_MS = SPLASH_FADE_MS + 100
// Splash 背景色（与 index.html #boot-splash 及 global.css 主题一致）
export const SPLASH_BG_LIGHT = '#F7F8FC'
export const SPLASH_BG_DARK = '#0F172A'

// services 初始化硬超时：超过后不再无限阻塞 Splash，而是进入错误态（展示「重试初始化」）。
// 该值必须远大于冷启动正常路径（首次安装 / 冷启动含 token 刷新，实测最坏数秒）。
export const SERVICE_INIT_TIMEOUT_MS = 20000
// 单个初始化阶段的软超时：仅用于日志告警，不中断（阶段耗时超过即打印 [init-warn]）。
export const SERVICE_INIT_STAGE_WARN_MS = 6000
// Renderer 侧安全网：自 listener 注册起，若超过该时长仍未完成 Splash，
// 主动调用 BOOT_GET_STATE 拉取 Main 当前状态，弥补任何丢失的 push。
export const RENDERER_BOOT_STATE_POLL_MS = 4000
