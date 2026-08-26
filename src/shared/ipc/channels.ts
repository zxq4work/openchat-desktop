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
  CONVERSATIONS_UPDATE_ROLE: 'conversations:update-role',
  CONVERSATIONS_UPDATE_MODEL: 'conversations:update-model',
  CONVERSATIONS_UPDATE_EFFORT: 'conversations:update-effort',
  CONVERSATIONS_UPDATE_USE_MODEL_INSTRUCTIONS: 'conversations:update-use-model-instructions',
  CONVERSATIONS_UPDATE_WEB_SEARCH: 'conversations:update-web-search',
  CONVERSATIONS_NEW_TOPIC: 'conversations:new-topic',

  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_INTERRUPT: 'chat:interrupt',
  CHAT_REGENERATE_LAST: 'chat:regenerate-last',

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
  CHAT_STREAM_RESET: 'chat:stream-reset',

  // Settings
  SETTINGS_GET_PROXY: 'settings:get-proxy',
  SETTINGS_SET_PROXY: 'settings:set-proxy',
  SETTINGS_GET_DEFAULT_MODEL: 'settings:get-default-model',
  SETTINGS_SET_DEFAULT_MODEL: 'settings:set-default-model',
  SETTINGS_GET_WEB_SEARCH_ENGINE: 'settings:get-web-search-engine',
  SETTINGS_SET_WEB_SEARCH_ENGINE: 'settings:set-web-search-engine',

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
  CONVERSATIONS_UPDATE_PROVIDER: 'conversations:update-provider',
} as const