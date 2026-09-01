import { contextBridge, ipcRenderer } from 'electron'
import type { CodexUsageView } from '../shared/types/usage'

// Inline IPC channel constants to avoid module resolution issues in sandboxed preload
const IPC_CHANNELS = {
  AUTH_GET_STATUS: 'auth:get-status',
  AUTH_LOGIN_BROWSER: 'auth:login-browser',
  AUTH_LOGIN_DEVICE_CODE: 'auth:login-device-code',
  AUTH_CANCEL_LOGIN: 'auth:cancel-login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_CHANGED: 'auth:changed',
  MODELS_LIST: 'models:list',
  MODELS_REFRESH: 'models:refresh',
  MODELS_CHANGED: 'models:changed',
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
  CONVERSATIONS_NEW_TOPIC: 'conversations:new-topic',
  CONVERSATIONS_UPDATE_PROVIDER: 'conversations:update-provider',
  CHAT_SEND: 'chat:send',
  CHAT_INTERRUPT: 'chat:interrupt',
  CHAT_REGENERATE_LAST: 'chat:regenerate-last',
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
  DRAFT_GET: 'draft:get',
  DRAFT_SET: 'draft:set',
  DRAFT_DELETE: 'draft:delete',
  SHORTCUT_NEW_CONVERSATION: 'shortcut:new-conversation',
  SHORTCUT_NEW_TOPIC: 'shortcut:new-topic',
  SHORTCUT_SETTINGS: 'shortcut:settings',
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  DIAGNOSTICS_CODEX_USAGE: 'diagnostics:codex-usage',
  CODEX_USAGE_GET_STATE: 'codex-usage:get-state',
  CODEX_USAGE_REFRESH: 'codex-usage:refresh',
  CODEX_USAGE_CHANGED: 'codex-usage:changed',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_CREATE: 'providers:create',
  PROVIDERS_DELETE: 'providers:delete',
  PROVIDERS_UPDATE: 'providers:update',
  PROVIDERS_FETCH_MODELS: 'providers:fetch-models',
  GOOGLE_SEARCH_OPEN_SESSION: 'google-search:open-session',
  APP_READY: 'app:ready',
} as const

const openchat = {
  auth: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_STATUS),
    loginBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN_BROWSER),
    loginDeviceCode: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN_DEVICE_CODE),
    cancelLogin: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CANCEL_LOGIN),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),
  },

  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.MODELS_LIST),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.MODELS_REFRESH),
  },

  conversations: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_GET, id),
    create: (modelId: string | null, effort: string | null, systemPrompt?: string, providerId?: string | null, webSearchEnabled?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_CREATE, modelId, effort, systemPrompt, providerId, webSearchEnabled),
    rename: (id: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_RENAME, id, title),
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_REMOVE, id),
    removeAll: () => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_REMOVE_ALL),
    updateRole: (id: string, prompt: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_ROLE, id, prompt),
    updateModel: (id: string, modelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_MODEL, id, modelId),
    updateEffort: (id: string, effort: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_EFFORT, id, effort),
    updateUseModelInstructions: (id: string, useModelInstructions: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_USE_MODEL_INSTRUCTIONS, id, useModelInstructions),
    updateWebSearchEnabled: (id: string, webSearchEnabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_WEB_SEARCH, id, webSearchEnabled),
    updateCodexSearchMode: (id: string, mode: 'hosted' | 'standalone') =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_CODEX_SEARCH_MODE, id, mode),
    updateProviderConfig: (id: string, providerConfigId: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE_PROVIDER, id, providerConfigId),
    newTopic: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_NEW_TOPIC, id),
  },

  chat: {
    send: (id: string, text: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, id, text),
    interrupt: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_INTERRUPT),
  },

  settings: {
    getProxy: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_PROXY),
    setProxy: (config: { enabled: boolean; protocol: string; host: string; port: string; username: string; password: string; mode?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_PROXY, config),
    resolveSystemProxy: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESOLVE_SYSTEM_PROXY, url) as Promise<string>,
    refreshSystemProxy: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_REFRESH_SYSTEM_PROXY),
    getDefaultModel: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_DEFAULT_MODEL) as Promise<{ providerId: string | null; modelId: string | null; effort: string | null }>,
    setDefaultModel: (providerId: string | null, modelId: string | null, effort: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_DEFAULT_MODEL, providerId, modelId, effort),
    getDefaultWebSearch: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_DEFAULT_WEB_SEARCH) as Promise<boolean>,
    setDefaultWebSearch: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_DEFAULT_WEB_SEARCH, enabled),
    getWebSearchEngine: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_WEB_SEARCH_ENGINE) as Promise<string>,
    setWebSearchEngine: (engine: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET_WEB_SEARCH_ENGINE, engine),
    getDraft: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.DRAFT_GET, conversationId) as Promise<string | null>,
    setDraft: (conversationId: string, text: string) => ipcRenderer.invoke(IPC_CHANNELS.DRAFT_SET, conversationId, text),
    deleteDraft: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.DRAFT_DELETE, conversationId),
  },

  googleSearch: {
    openSession: () => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_SEARCH_OPEN_SESSION),
  },

  providers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_LIST),
    create: (config: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_CREATE, config),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_DELETE, id),
    update: (id: string, updates: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_UPDATE, id, updates),
    fetchModels: (baseUrl: string, apiKey: string, modelsPath?: string, providerId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_FETCH_MODELS, { baseUrl, apiKey, modelsPath, providerId }),
  },

  events: {
    onAuthChanged: (cb: (status: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: string) => cb(status)
      ipcRenderer.on(IPC_CHANNELS.AUTH_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTH_CHANGED, handler)
    },
    onModelsChanged: (cb: (models: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, models: unknown[]) => cb(models)
      ipcRenderer.on(IPC_CHANNELS.MODELS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MODELS_CHANGED, handler)
    },
    onChatDelta: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_DELTA, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_DELTA, handler)
    },
    onChatReasoningStarted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REASONING_STARTED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REASONING_STARTED, handler)
    },
    onChatReasoningDelta: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REASONING_DELTA, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REASONING_DELTA, handler)
    },
    onChatReasoningCompleted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REASONING_COMPLETED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REASONING_COMPLETED, handler)
    },
    onTurnCompleted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_TURN_COMPLETED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_TURN_COMPLETED, handler)
    },
    onChatError: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_ERROR, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_ERROR, handler)
    },
    onWebSearchStarted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_WEB_SEARCH_STARTED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_WEB_SEARCH_STARTED, handler)
    },
    onWebSearchCompleted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_WEB_SEARCH_COMPLETED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_WEB_SEARCH_COMPLETED, handler)
    },
    onWebSearchError: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_WEB_SEARCH_ERROR, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_WEB_SEARCH_ERROR, handler)
    },
    onWebSearchCallStarted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_STARTED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_STARTED, handler)
    },
    onWebSearchCallCompleted: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_COMPLETED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_COMPLETED, handler)
    },
    onWebSearchCallFailed: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_FAILED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_FAILED, handler)
    },
    onStreamReset: (cb: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: unknown) => cb(eventData)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_RESET, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_RESET, handler)
    },
    onNewConversation: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on(IPC_CHANNELS.SHORTCUT_NEW_CONVERSATION, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SHORTCUT_NEW_CONVERSATION, handler)
    },
    onNewTopic: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on(IPC_CHANNELS.SHORTCUT_NEW_TOPIC, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SHORTCUT_NEW_TOPIC, handler)
    },
  },

  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),

  diagnostics: {
    codexUsage: () => ipcRenderer.invoke(IPC_CHANNELS.DIAGNOSTICS_CODEX_USAGE),
  },

  codexUsage: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_USAGE_GET_STATE),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_USAGE_REFRESH),
    onChanged: (cb: (view: CodexUsageView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, view: CodexUsageView) => cb(view)
      ipcRenderer.on(IPC_CHANNELS.CODEX_USAGE_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_USAGE_CHANGED, handler)
    },
  },

  app: {
    notifyReady: () => ipcRenderer.send(IPC_CHANNELS.APP_READY),
  },
}

contextBridge.exposeInMainWorld('openchat', openchat)

export type OpenChatAPI = typeof openchat