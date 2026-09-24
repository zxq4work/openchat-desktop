// IPC 通道名称，主进程和渲染进程共享
export const IPC_CHANNELS = {
  // Auth
  AUTH_GET_STATUS: 'auth:get-status',
  AUTH_LOGIN_BROWSER: 'auth:login-browser',
  AUTH_LOGIN_DEVICE_CODE: 'auth:login-device-code',
  AUTH_CANCEL_LOGIN: 'auth:cancel-login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_CHANGED: 'auth:changed',

  // Models
  MODELS_LIST: 'models:list',
  MODELS_REFRESH: 'models:refresh',
  MODELS_CHANGED: 'models:changed',

  // Conversations
  CONVERSATIONS_LIST: 'conversations:list',
  CONVERSATIONS_GET: 'conversations:get',
  CONVERSATIONS_CREATE: 'conversations:create',
  CONVERSATIONS_RENAME: 'conversations:rename',
  CONVERSATIONS_REMOVE: 'conversations:remove',
  CONVERSATIONS_REMOVE_ALL: 'conversations:remove-all',
  CONVERSATIONS_UPDATE_ROLE: 'conversations:update-role',
  CONVERSATIONS_UPDATE_MODEL: 'conversations:update-model',
  CONVERSATIONS_UPDATE_EFFORT: 'conversations:update-effort',
  CONVERSATIONS_UPDATE_USE_MODEL_INSTRUCTIONS: 'conversations:update-use-model-instructions',
  CONVERSATIONS_UPDATE_WEB_SEARCH: 'conversations:update-web-search',
  CONVERSATIONS_UPDATE_CODEX_SEARCH_MODE: 'conversations:update-codex-search-mode',
  CONVERSATIONS_UPDATE_SEARCH_ENGINE: 'conversations:update-search-engine',
  CONVERSATIONS_NEW_TOPIC: 'conversations:new-topic',
  // 全局会话搜索（只读）：跨所有会话检索标题 / 正文
  CONVERSATIONS_SEARCH: 'conversations:search',
  CONVERSATIONS_SEARCH_MATCHES: 'conversations:search-matches',

  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_INTERRUPT: 'chat:interrupt',
  CHAT_REGENERATE_LAST: 'chat:regenerate-last',

  // Image Generation
  IMAGE_GENERATION_GENERATE: 'image-generation:generate',
  IMAGE_GENERATION_INTERRUPT: 'image-generation:interrupt',
  IMAGE_GENERATION_LIST: 'image-generation:list',
  CONVERSATIONS_UPDATE_IMAGE_DEFAULTS: 'conversations:update-image-defaults',
  IMAGE_GENERATION_STARTED: 'image-generation:started',
  IMAGE_GENERATION_COMPLETED: 'image-generation:completed',
  IMAGE_GENERATION_FAILED: 'image-generation:failed',

  // Events (Main -> Renderer)
  CHAT_DELTA: 'chat:delta',
  CHAT_REASONING_STARTED: 'chat:reasoning-started',
  CHAT_REASONING_DELTA: 'chat:reasoning-delta',
  CHAT_REASONING_COMPLETED: 'chat:reasoning-completed',
  CHAT_TURN_COMPLETED: 'chat:turn-completed',
  CHAT_ERROR: 'chat:error',
  CHAT_WEB_SEARCH_STARTED: 'chat:web-search-started',
  CHAT_WEB_SEARCH_COMPLETED: 'chat:web-search-completed',
  CHAT_WEB_SEARCH_ERROR: 'chat:web-search-error',
  CHAT_WEB_SEARCH_CALL_STARTED: 'chat:web-search-call-started',
  CHAT_WEB_SEARCH_CALL_COMPLETED: 'chat:web-search-call-completed',
  CHAT_WEB_SEARCH_CALL_FAILED: 'chat:web-search-call-failed',
  CHAT_STREAM_RESET: 'chat:stream-reset',

  // Settings
  SETTINGS_GET_PROXY: 'settings:get-proxy',
  SETTINGS_SET_PROXY: 'settings:set-proxy',
  SETTINGS_RESOLVE_SYSTEM_PROXY: 'settings:resolve-system-proxy',
  SETTINGS_REFRESH_SYSTEM_PROXY: 'settings:refresh-system-proxy',
  SETTINGS_GET_DEFAULT_MODEL: 'settings:get-default-model',
  SETTINGS_SET_DEFAULT_MODEL: 'settings:set-default-model',
  SETTINGS_GET_DEFAULT_WEB_SEARCH: 'settings:get-default-web-search',
  SETTINGS_SET_DEFAULT_WEB_SEARCH: 'settings:set-default-web-search',
  SETTINGS_GET_WEB_SEARCH_ENGINE: 'settings:get-web-search-engine',
  SETTINGS_SET_WEB_SEARCH_ENGINE: 'settings:set-web-search-engine',
  SETTINGS_GET_WEB_SEARCH_CONFIG: 'settings:get-web-search-config',
  SETTINGS_SET_WEB_SEARCH_CONFIG: 'settings:set-web-search-config',

  // Composer draft (per conversation)
  DRAFT_GET: 'draft:get',
  DRAFT_SET: 'draft:set',
  DRAFT_DELETE: 'draft:delete',

  // Attachments (图片输入)
  ATTACHMENTS_PICK_IMAGES: 'attachments:pick-images',
  ATTACHMENTS_PREPARE_FROM_BYTES: 'attachments:prepare-from-bytes',
  ATTACHMENTS_DELETE: 'attachments:delete',
  ATTACHMENTS_LIST_DRAFTS: 'attachments:list-drafts',
  ATTACHMENTS_SET_DETAIL: 'attachments:set-detail',
  // 保存受管图片到用户选择的位置（renderer 不接触内部路径）
  ATTACHMENTS_SAVE: 'attachments:save',
  // 复制受管图片位图到系统剪贴板（renderer 只传 attachmentId）
  ATTACHMENTS_COPY_IMAGE: 'attachments:copy-image',

  // UI
  SHORTCUT_NEW_CONVERSATION: 'shortcut:new-conversation',
  SHORTCUT_NEW_TOPIC: 'shortcut:new-topic',
  SHORTCUT_SETTINGS: 'shortcut:settings',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',

  // Codex Usage
  CODEX_USAGE_GET_STATE: 'codex-usage:get-state',
  CODEX_USAGE_REFRESH: 'codex-usage:refresh',
  CODEX_USAGE_CHANGED: 'codex-usage:changed',

  // Diagnostics
  DIAGNOSTICS_CODEX_USAGE: 'diagnostics:codex-usage',

  // Providers
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_CREATE: 'providers:create',
  PROVIDERS_DELETE: 'providers:delete',
  PROVIDERS_UPDATE: 'providers:update',
  PROVIDERS_FETCH_MODELS: 'providers:fetch-models',
  // 按需读取已保存的 API Key 明文（用户主动点「小眼睛」时才调用，绝不随列表返回）
  PROVIDERS_REVEAL_API_KEY: 'providers:reveal-api-key',
  CONVERSATIONS_UPDATE_PROVIDER: 'conversations:update-provider',

  // App
  APP_READY: 'app:ready',
  BOOT_FINISH_SPLASH: 'boot:finish-splash',
  // Renderer 显式声明自己已注册好 BOOT_FINISH_SPLASH listener（不再依赖 5s 推测）。
  BOOT_RENDERER_READY: 'boot:renderer-ready',
  // Renderer 主动拉取当前 boot 状态（错过 push 时的持久化补救路径）。
  BOOT_GET_STATE: 'boot:get-state',
  BOOT_SET_THEME: 'boot:set-theme',
  BOOT_WINDOW_SHOWN: 'boot:window-shown',
  BOOT_SPLASH_PAINTED: 'boot:splash-painted',
  BOOT_OPACITY_GATE_READY: 'boot:opacity-gate-ready',
  // 主界面错误态：初始化失败/超时后由 Main 推送给 Renderer，展示错误与「重试初始化」。
  BOOT_INIT_ERROR: 'boot:init-error',
  // Renderer 请求重试初始化（错误态下用户点击重试）。
  BOOT_RETRY_INIT: 'boot:retry-init',
  // Renderer 完成 Splash 切换后的确认，仅用于停止 resend 兜底。
  BOOT_FINISH_ACK: 'boot:finish-ack',
  // Main services 真正 Ready（首次成功或 Retry 成功后）推送，触发 Renderer 数据 hydrate。
  BOOT_SERVICES_READY: 'boot:services-ready',

  // Google Search Session
  GOOGLE_SEARCH_OPEN_SESSION: 'google-search:open-session',
} as const