import { ipcMain, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { PublicAccountInfo } from '../../shared/types/account'
import type { ModelInfo } from '../../shared/types/model'
import type { Conversation, ContextSegment, Message } from '../../shared/types/conversation'
import type { ProxyConfig } from '../../shared/types/settings'
import { setProxyConfig, createRequest, applyProxyMode, forceReloadProxyConfig, closeAllConnections, resolveSystemProxy } from '../openai/chatgpt/httpsClient'
import { fetchCodexUsage } from '../openai/chatgpt/codexUsageDiagnostics'
import type { OAuthCredentialManager } from '../openai/chatgpt/auth/OAuthCredentialManager'
import { ChatGPTUsageService } from '../openai/chatgpt/usage/ChatGPTUsageService'
import type { CodexUsageView } from '../../shared/types/usage'
import type { CustomProviderConfig } from '../../shared/types/provider'
import type { WebSearchEngineType } from '../../shared/types/settings'
import { getSearchEngine } from '../web-search/SearchEngineFactory'
import type { SearchEngine } from '../web-search/WebSearchService'
import { googleSearchBrowser } from '../web-search/GoogleSearchBrowserService'

interface Services {
  appServerProcess: { isRunning: boolean } | null
  settingsRepository: {
    get: (key: string) => string | null
    set: (key: string, value: string) => void
    remove: (key: string) => void
  } | null
  providerConfigService: {
    listSafe: () => Array<Omit<CustomProviderConfig, 'apiKey'> & { hasApiKey: boolean }>
    create: (config: Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>) => Omit<CustomProviderConfig, 'apiKey'> & { hasApiKey: boolean }
    delete: (id: string) => void
    update: (id: string, updates: Partial<Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>>) => void
    getApiKey?: (id: string) => string | null
  } | null
  authService: {
    checkAuth: () => Promise<PublicAccountInfo>
    loginBrowser: () => Promise<string>
    loginDeviceCode: () => Promise<{ verificationUrl: string; userCode: string }>
    cancelLogin: () => Promise<void>
    logout: () => Promise<void>
    currentStatus: string
    onStatusChange?: (handler: (status: string) => void) => void
  } | null
  modelService: {
    fetchModels: () => Promise<ModelInfo[]>
    currentModels: ModelInfo[]
  } | null
  conversationService: {
    listConversations: () => Conversation[]
    getConversation: (id: string) => { conversation: Conversation; segments: ContextSegment[]; messages: Message[] } | null
    createConversation: (modelId: string | null, effort: string | null, systemPrompt?: string, providerConfigId?: string | null) => Conversation
    renameConversation: (id: string, title: string) => void
    removeConversation: (id: string) => Promise<void>
    updateRole: (id: string, prompt: string) => void
    updateModel: (id: string, modelId: string) => Promise<void>
    updateEffort: (id: string, effort: string) => Promise<void>
    updateUseModelInstructions: (id: string, useModelInstructions: boolean) => Promise<void>
    updateWebSearchEnabled: (id: string, webSearchEnabled: boolean) => Promise<void>
    updateProviderConfig: (id: string, providerConfigId: string | null) => Promise<void>
    newTopic: (id: string) => ContextSegment | null
    sendMessage: (id: string, text: string) => Promise<{ userMessage: Message; assistantMessage: Message } | null>
    interrupt: () => Promise<void>
    onStreamEvent: (handler: (event: unknown) => void) => void
  } | null
  credentialManager: OAuthCredentialManager | null
  usageService: ChatGPTUsageService | null
  webSearchService: { clearCache: () => void; setEngine: (engine: SearchEngine) => void } | null
}

async function fetchModelsFromUrl(url: string, apiKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = createRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : undefined,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
        protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              console.log('[fetchModels] raw response:', data)
              const parsed = JSON.parse(data)
              const models: string[] = []
              if (Array.isArray(parsed)) {
                // 直接数组
                for (const item of parsed) {
                  if (item && typeof item === 'object' && typeof item.id === 'string') {
                    models.push(item.id)
                  }
                }
              } else if (Array.isArray(parsed.data)) {
                // { data: [{ id: "..." }] }
                for (const item of parsed.data) {
                  if (item && typeof item === 'object' && typeof item.id === 'string') {
                    models.push(item.id)
                  }
                }
              }
              resolve(models)
            } catch {
              reject(new Error('Invalid JSON from models endpoint'))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
    req.on('error', reject)
    req.end()
  })
}

export function registerIpcHandlers(services: Services, getMainWindow: () => BrowserWindow | null): void {
  // ===== Settings =====
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_PROXY, (): ProxyConfig | null => {
    const raw = services.settingsRepository?.get('proxy_config') ?? null
    if (!raw) return null
    try {
      return JSON.parse(raw) as ProxyConfig
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_PROXY, async (_event, config: ProxyConfig): Promise<void> => {
    services.settingsRepository?.set('proxy_config', JSON.stringify(config))
    setProxyConfig(config)

    // 将代理模式应用到 Electron session（system/direct 走 Chromium，http/socks5 由 Node agent 处理）
    await applyProxyMode()
    await closeAllConnections()

    // 同步代理到 Google 搜索 BrowserWindow session
    await googleSearchBrowser.syncProxyToSession()

    // 开启代理且 ChatGPT 已登录时，主动执行一次 codex 额度查询
    if (config.enabled) {
      const auth = await services.authService?.checkAuth()
      if (auth?.loggedIn) {
        void services.usageService?.refresh()
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_RESOLVE_SYSTEM_PROXY, async (_event, url: string): Promise<string> => {
    try {
      return await resolveSystemProxy(url)
    } catch {
      return 'DIRECT'
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_REFRESH_SYSTEM_PROXY, async (): Promise<void> => {
    await forceReloadProxyConfig()
    await closeAllConnections()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_DEFAULT_MODEL, (): { providerId: string | null; modelId: string | null; effort: string | null } => {
    const raw = services.settingsRepository?.get('default_model') ?? null
    if (!raw) return { providerId: null, modelId: null, effort: null }
    try {
      return JSON.parse(raw) as { providerId: string | null; modelId: string | null; effort: string | null }
    } catch {
      return { providerId: null, modelId: null, effort: null }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_DEFAULT_MODEL, (_event, providerId: string | null, modelId: string | null, effort: string | null): void => {
    services.settingsRepository?.set('default_model', JSON.stringify({ providerId, modelId, effort }))
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_WEB_SEARCH_ENGINE, (): string => {
    const raw = services.settingsRepository?.get('web_search_engine') ?? null
    return raw === 'baidu' || raw === 'bing' || raw === 'google' ? raw : 'bing'
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_WEB_SEARCH_ENGINE, (_event, engine: string): void => {
    const normalized: WebSearchEngineType = engine === 'baidu' || engine === 'google' ? engine : 'bing'
    services.settingsRepository?.set('web_search_engine', normalized)
    // 切换 WebSearchService 内部的搜索引擎，并清空缓存
    if (services.webSearchService) {
      services.webSearchService.setEngine(getSearchEngine(normalized))
    }
  })

  // ===== Composer drafts =====
  ipcMain.handle(IPC_CHANNELS.DRAFT_GET, (_event, conversationId: string): string | null => {
    return services.settingsRepository?.get(`draft_${conversationId}`) ?? null
  })

  const draftDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  ipcMain.handle(IPC_CHANNELS.DRAFT_SET, (_event, conversationId: string, text: string): void => {
    // 防抖 500ms，避免频繁触发 sql.js 全量导出
    const key = `draft_${conversationId}`
    const existing = draftDebounceTimers.get(key)
    if (existing) clearTimeout(existing)
    draftDebounceTimers.set(key, setTimeout(() => {
      draftDebounceTimers.delete(key)
      services.settingsRepository?.set(key, text)
    }, 500))
  })

  ipcMain.handle(IPC_CHANNELS.DRAFT_DELETE, (_event, conversationId: string): void => {
    const key = `draft_${conversationId}`
    const existing = draftDebounceTimers.get(key)
    if (existing) { clearTimeout(existing); draftDebounceTimers.delete(key) }
    services.settingsRepository?.remove(key)
  })

  // ===== Auth =====
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async (): Promise<PublicAccountInfo> => {
    return services.authService?.checkAuth() ?? { loggedIn: false, email: null, planType: null, userId: null, accountId: null }
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN_BROWSER, async (): Promise<string> => {
    const authUrl = await (services.authService?.loginBrowser() ?? '')
    if (authUrl) {
      shell.openExternal(authUrl)
    }
    return authUrl
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN_DEVICE_CODE, async (): Promise<{ verificationUrl: string; userCode: string }> => {
    return services.authService?.loginDeviceCode() ?? { verificationUrl: '', userCode: '' }
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_CANCEL_LOGIN, async (): Promise<void> => {
    await services.authService?.cancelLogin()
  })

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (): Promise<void> => {
    await services.authService?.logout()
  })

  // ===== Models =====
  ipcMain.handle(IPC_CHANNELS.MODELS_LIST, async (): Promise<ModelInfo[]> => {
    return services.modelService?.currentModels ?? []
  })

  ipcMain.handle(IPC_CHANNELS.MODELS_REFRESH, async (): Promise<ModelInfo[]> => {
    return services.modelService?.fetchModels() ?? []
  })

  // ===== Conversations =====
  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_LIST, (): Conversation[] => {
    return services.conversationService?.listConversations() ?? []
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_GET, (_event, id: string) => {
    return services.conversationService?.getConversation(id) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_CREATE, (_event, modelId: string | null, effort: string | null, systemPrompt?: string, providerId?: string | null): Conversation | null => {
    return services.conversationService?.createConversation(modelId, effort, systemPrompt, providerId) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_RENAME, (_event, id: string, title: string): void => {
    services.conversationService?.renameConversation(id, title)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_REMOVE, async (_event, id: string): Promise<void> => {
    await services.conversationService?.removeConversation(id)
    // 清理草稿
    services.settingsRepository?.remove(`draft_${id}`)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_ROLE, (_event, id: string, prompt: string): void => {
    services.conversationService?.updateRole(id, prompt)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_MODEL, async (_event, id: string, modelId: string): Promise<void> => {
    await services.conversationService?.updateModel(id, modelId)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_EFFORT, async (_event, id: string, effort: string): Promise<void> => {
    await services.conversationService?.updateEffort(id, effort)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_USE_MODEL_INSTRUCTIONS, async (_event, id: string, useModelInstructions: boolean): Promise<void> => {
    await services.conversationService?.updateUseModelInstructions(id, useModelInstructions)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_WEB_SEARCH, async (_event, id: string, webSearchEnabled: boolean): Promise<void> => {
    await services.conversationService?.updateWebSearchEnabled(id, webSearchEnabled)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_NEW_TOPIC, (_event, id: string): ContextSegment | null => {
    return services.conversationService?.newTopic(id) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_PROVIDER, async (_event, id: string, providerConfigId: string | null): Promise<void> => {
    await services.conversationService?.updateProviderConfig(id, providerConfigId)
  })

  // ===== Providers =====
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, () => {
    return services.providerConfigService?.listSafe() ?? []
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_CREATE, (_event, config: Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>) => {
    return services.providerConfigService?.create(config) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DELETE, (_event, id: string) => {
    services.providerConfigService?.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_UPDATE, (_event, id: string, updates: Partial<Omit<CustomProviderConfig, 'id' | 'createdAt' | 'updatedAt'>>) => {
    services.providerConfigService?.update(id, updates)
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_FETCH_MODELS, async (_event, params: { baseUrl: string; apiKey: string; modelsPath?: string; providerId?: string }) => {
    const { baseUrl, apiKey: inputKey, modelsPath, providerId } = params
    // 编辑模式下 apiKey 可能为空，尝试从存储中获取
    let apiKey = inputKey
    if (!apiKey && providerId) {
      apiKey = services.providerConfigService?.getApiKey?.(providerId) ?? ''
    }
    const url = modelsPath
      ? (baseUrl.replace(/\/+$/, '') + (modelsPath.startsWith('/') ? modelsPath : '/' + modelsPath))
      : (baseUrl.replace(/\/+$/, '') + '/models')
    return await fetchModelsFromUrl(url, apiKey)
  })

  // ===== Chat =====
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, id: string, text: string): Promise<{ userMessage: Message; assistantMessage: Message } | null> => {
    return await (services.conversationService?.sendMessage(id, text) ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_INTERRUPT, async (): Promise<void> => {
    await services.conversationService?.interrupt()
  })

  // ===== Codex Usage =====
  ipcMain.handle(IPC_CHANNELS.CODEX_USAGE_GET_STATE, (): CodexUsageView => {
    return services.usageService?.getView() ?? { state: 'unknown' }
  })

  ipcMain.handle(IPC_CHANNELS.CODEX_USAGE_REFRESH, async (): Promise<void> => {
    await services.usageService?.refresh()
  })

  // ===== Diagnostics (临时调试用) =====
  ipcMain.handle(IPC_CHANNELS.DIAGNOSTICS_CODEX_USAGE, async (): Promise<void> => {
    if (services.credentialManager) {
      await fetchCodexUsage(services.credentialManager)
    }
  })

  // ===== Shell =====
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, (_event, url: string): void => {
    shell.openExternal(url)
  })

  // ===== Google Search Session =====
  ipcMain.handle(IPC_CHANNELS.GOOGLE_SEARCH_OPEN_SESSION, (): void => {
    googleSearchBrowser.openSession()
  })

  // ===== Auth Events (Main -> Renderer) =====
  if (services.authService?.onStatusChange) {
    services.authService.onStatusChange((status: string) => {
      const win = getMainWindow()
      if (!win) return
      win.webContents.send(IPC_CHANNELS.AUTH_CHANGED, status)
    })
  }

  // ===== Events (Main -> Renderer) =====
  services.usageService?.onChange((view) => {
    const win = getMainWindow()
    if (!win) return
    win.webContents.send(IPC_CHANNELS.CODEX_USAGE_CHANGED, view)
  })

  services.conversationService?.onStreamEvent((event) => {
    const win = getMainWindow()
    if (!win) return

    const e = event as { type: string; conversationId?: string }
    console.log('[Chat IPC Send] event=%s conversationId=%s targetWebContentsId=%d', e.type, e.conversationId ?? '?', win.webContents.id)

    switch (e.type) {
      case 'delta':
        win.webContents.send(IPC_CHANNELS.CHAT_DELTA, event)
        break
      case 'reasoning-started':
        win.webContents.send(IPC_CHANNELS.CHAT_REASONING_STARTED, event)
        break
      case 'reasoning-delta':
        win.webContents.send(IPC_CHANNELS.CHAT_REASONING_DELTA, event)
        break
      case 'reasoning-completed':
        win.webContents.send(IPC_CHANNELS.CHAT_REASONING_COMPLETED, event)
        break
      case 'turn-completed':
        win.webContents.send(IPC_CHANNELS.CHAT_TURN_COMPLETED, event)
        break
      case 'error':
        win.webContents.send(IPC_CHANNELS.CHAT_ERROR, event)
        break
      case 'web-search-started':
        win.webContents.send(IPC_CHANNELS.CHAT_WEB_SEARCH_STARTED, event)
        break
      case 'web-search-completed':
        win.webContents.send(IPC_CHANNELS.CHAT_WEB_SEARCH_COMPLETED, event)
        break
      case 'web-search-error':
        win.webContents.send(IPC_CHANNELS.CHAT_WEB_SEARCH_ERROR, event)
        break
      case 'stream-reset':
        win.webContents.send(IPC_CHANNELS.CHAT_STREAM_RESET, event)
        break
    }
  })
}