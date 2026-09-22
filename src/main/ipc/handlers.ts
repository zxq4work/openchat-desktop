import { ipcMain, BrowserWindow, shell, dialog, clipboard, nativeImage } from 'electron'
import * as fs from 'fs'
import type { AttachmentService } from '../services/attachments/AttachmentService'
import type { MessageAttachment, ImageDetail, AttachmentImportResult, AttachmentUsage } from '../../shared/types/conversation'
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
import type { WebSearchEngineType, WebSearchConfig } from '../../shared/types/settings'
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../shared/types/settings'
import { getSearchEngine } from '../web-search/SearchEngineFactory'
import type { SearchEngine } from '../web-search/WebSearchService'
import { googleSearchBrowser } from '../web-search/GoogleSearchBrowserService'
import { writeBootTheme, type BootTheme } from '../bootstrap/BootPreferences'

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
    createConversation: (modelId: string | null, effort: string | null, systemPrompt?: string, providerConfigId?: string | null, webSearchEnabled?: boolean, searchEngine?: 'bing' | 'baidu' | 'google', type?: 'chat' | 'image_generation') => Conversation
    renameConversation: (id: string, title: string) => void
    removeConversation: (id: string) => Promise<void>
    removeAllConversations: () => Promise<void>
    updateRole: (id: string, prompt: string) => void
    updateModel: (id: string, modelId: string) => Promise<void>
    updateEffort: (id: string, effort: string) => Promise<void>
    updateImageDefaults: (id: string, size: string | null, quality: string | null, background: string | null) => Promise<void>
    updateUseModelInstructions: (id: string, useModelInstructions: boolean) => Promise<void>
    updateWebSearchEnabled: (id: string, webSearchEnabled: boolean) => Promise<void>
    updateCodexSearchMode: (id: string, mode: 'hosted' | 'standalone') => Promise<void>
    updateSearchEngine: (id: string, engine: 'bing' | 'baidu' | 'google') => Promise<void>
    updateWebSearchConfig: (config: WebSearchConfig) => void
    updateProviderConfig: (id: string, providerConfigId: string | null) => Promise<void>
    newTopic: (id: string) => ContextSegment | null
    sendMessage: (id: string, text: string, attachmentIds?: string[]) => Promise<{ userMessage: Message; assistantMessage: Message; reasoningDisplayMode: 'none' | 'summary' | 'live' } | null>
    interrupt: () => Promise<void>
    onStreamEvent: (handler: (event: unknown) => void) => void
  } | null
  imageGenerationService: {
    generate: (conversationId: string, prompt: string, params: { size?: string | null; quality?: string | null; background?: string | null; outputFormat?: string | null }, inputAttachmentIds?: string[]) => Promise<{ userMessage: Message; assistantMessage: Message }>
    interrupt: () => Promise<void>
    listGenerations: (conversationId: string) => import('../../shared/types/conversation').ImageGeneration[]
    onStreamEvent: (handler: (event: unknown) => void) => void
  } | null
  credentialManager: OAuthCredentialManager | null
  usageService: ChatGPTUsageService | null
  webSearchService: { clearCache: () => void; setEngine: (engine: SearchEngine, engineName?: string) => void; getEngineName: () => string; setMaxResults: (n: number) => void } | null
  webSearchConfig: WebSearchConfig | null
  attachmentService: AttachmentService | null
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
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

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_DEFAULT_WEB_SEARCH, (): boolean => {
    const raw = services.settingsRepository?.get('default_web_search') ?? null
    return raw === '1'
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_DEFAULT_WEB_SEARCH, (_event, enabled: boolean): void => {
    services.settingsRepository?.set('default_web_search', enabled ? '1' : '0')
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
      services.webSearchService.setEngine(getSearchEngine(normalized), normalized)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_WEB_SEARCH_CONFIG, (): WebSearchConfig => {
    const raw = services.settingsRepository?.get('web_search_config') ?? null
    if (!raw) return { ...DEFAULT_WEB_SEARCH_CONFIG }
    try {
      const parsed = JSON.parse(raw) as Partial<WebSearchConfig>
      return {
        maxResults: clampInt(parsed.maxResults, 3, 20, DEFAULT_WEB_SEARCH_CONFIG.maxResults),
        maxToolRounds: clampInt(parsed.maxToolRounds, 2, 10, DEFAULT_WEB_SEARCH_CONFIG.maxToolRounds),
      }
    } catch {
      return { ...DEFAULT_WEB_SEARCH_CONFIG }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_WEB_SEARCH_CONFIG, (_event, config: WebSearchConfig): void => {
    const normalized: WebSearchConfig = {
      maxResults: clampInt(config?.maxResults, 3, 20, DEFAULT_WEB_SEARCH_CONFIG.maxResults),
      maxToolRounds: clampInt(config?.maxToolRounds, 2, 10, DEFAULT_WEB_SEARCH_CONFIG.maxToolRounds),
    }
    services.settingsRepository?.set('web_search_config', JSON.stringify(normalized))
    // 同步到运行时 WebSearchService 与 ToolLoop 默认值
    services.webSearchConfig = normalized
    services.conversationService?.updateWebSearchConfig(normalized)
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

  // ===== Attachments (图片输入) =====
  // 单张失败不阻断整批：成功项保留，失败项以 code 回传由 renderer 提示。
  // 失败项不产生任何 DB 记录或落盘文件。
  const errInfo = (err: unknown, fileName: string): AttachmentImportResult['errors'][number] => {
    const code = (err as { code?: string })?.code ?? 'attachment_failed'
    const message = err instanceof Error ? err.message : String(err)
    console.error('[IPC attachments] error code=%s file=%s message=%s', code, fileName, message)
    return { fileName, code, message }
  }

  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_PICK_IMAGES, async (_event, conversationId: string | null, usage?: AttachmentUsage): Promise<AttachmentImportResult> => {
    if (!services.attachmentService) return { attachments: [], errors: [] }
    const win = getMainWindow()
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    }
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { attachments: [], errors: [] }
    const attachments: MessageAttachment[] = []
    const errors: AttachmentImportResult['errors'] = []
    for (const filePath of result.filePaths) {
      try {
        attachments.push(await services.attachmentService.prepareFromPath(filePath, conversationId, usage))
      } catch (err) {
        errors.push(errInfo(err, filePath.split(/[\\/]/).pop() ?? filePath))
      }
    }
    return { attachments, errors }
  })

  // 拖拽：renderer 只能拿到 File 对象，Electron 22 无 webUtils 拿不到路径。
  // 这里接收 renderer 读取的字节（ArrayBuffer/Uint8Array）+ 文件名，Main 侧按 magic bytes 校验。
  // usage 区分 Chat 图片输入 / 图片生成参考图（默认 chat_input，保持既有行为）。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_PREPARE_FROM_BYTES, (_event, payload: { conversationId: string | null; fileName: string; data: Uint8Array; usage?: AttachmentUsage }): MessageAttachment => {
    if (!services.attachmentService) throw new Error('attachment_service_unavailable')
    const fileName = payload.fileName || 'image'
    try {
      const buffer = Buffer.from(payload.data)
      return services.attachmentService.prepareFromBytes(buffer, fileName, payload.conversationId, payload.usage ?? 'chat_input')
    } catch (err) {
      const info = errInfo(err, fileName)
      throw new Error(`${info.code}: ${info.message}`)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_DELETE, (_event, attachmentId: string): void => {
    services.attachmentService?.deleteOne(attachmentId)
  })

  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_LIST_DRAFTS, (_event, conversationId: string, usage?: AttachmentUsage): MessageAttachment[] => {
    return services.attachmentService?.listDrafts(conversationId, usage) ?? []
  })

  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_SET_DETAIL, (_event, attachmentId: string, detail: ImageDetail): void => {
    services.attachmentService?.setDetail(attachmentId, detail)
  })

  // 把受管图片另存为用户选择的位置。renderer 只传 attachmentId，
  // Main 按 DB 反查受管原图路径后复制，绝不暴露内部路径给渲染进程。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_SAVE, async (_event, attachmentId: string): Promise<{ saved: boolean; canceled?: boolean; error?: string }> => {
    const att = services.attachmentService?.getAttachment(attachmentId)
    if (!att) return { saved: false, error: '附件不存在' }
    const resolved = services.attachmentService?.resolveOriginal(attachmentId)
    if (!resolved) return { saved: false, error: '附件文件不存在' }

    const win = getMainWindow()
    const options: Electron.SaveDialogOptions = {
      title: '保存图片',
      defaultPath: att.fileName || 'image.png',
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false, canceled: true }

    try {
      await fs.promises.copyFile(resolved.filePath, result.filePath)
      return { saved: true }
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : '保存失败' }
    }
  })

  // 复制受管图片位图到系统剪贴板。renderer 只传 attachmentId：
  // Main 按 DB 反查受管原图路径 → 读取字节 → nativeImage 解码 → clipboard.writeImage。
  // 始终使用原图（非缩略图），不做格式转换/压缩，保持 PNG 透明。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENTS_COPY_IMAGE, (_event, attachmentId: string): { copied: boolean; error?: string } => {
    const att = services.attachmentService?.getAttachment(attachmentId)
    if (!att) return { copied: false, error: '附件不存在' }
    if (att.type !== 'image' || !att.mimeType.startsWith('image/')) {
      return { copied: false, error: '不是图片附件' }
    }
    const resolved = services.attachmentService?.resolveOriginal(attachmentId)
    if (!resolved) return { copied: false, error: '附件文件不存在' }

    let bytes: Buffer
    try {
      bytes = fs.readFileSync(resolved.filePath)
    } catch {
      // 不打印路径 / 字节，只记录操作与附件身份
      console.error('[attachments:copy-image] read failed attachmentId=%s', attachmentId)
      return { copied: false, error: '无法读取图片文件' }
    }

    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) {
      console.error('[attachments:copy-image] decode failed attachmentId=%s', attachmentId)
      return { copied: false, error: '图片解码失败' }
    }

    try {
      clipboard.writeImage(image)
      return { copied: true }
    } catch (err) {
      console.error('[attachments:copy-image] clipboard write failed attachmentId=%s', attachmentId)
      return { copied: false, error: err instanceof Error ? err.message : '复制图片失败' }
    }
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
    const t0 = performance.now()
    const result = services.conversationService?.getConversation(id) ?? null
    const t1 = performance.now()
    console.log('[perf] ipc CONVERSATIONS_GET total=%dms msgs=%d',
      Math.round(t1 - t0), result?.messages?.length ?? 0)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_CREATE, (_event, modelId: string | null, effort: string | null, systemPrompt?: string, providerId?: string | null, webSearchEnabled?: boolean, searchEngine?: 'bing' | 'baidu' | 'google', type?: 'chat' | 'image_generation'): Conversation | null => {
    return services.conversationService?.createConversation(modelId, effort, systemPrompt, providerId, webSearchEnabled, searchEngine, type) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_RENAME, (_event, id: string, title: string): void => {
    services.conversationService?.renameConversation(id, title)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_REMOVE, async (_event, id: string): Promise<void> => {
    await services.conversationService?.removeConversation(id)
    // 清理草稿
    services.settingsRepository?.remove(`draft_${id}`)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_REMOVE_ALL, async (): Promise<void> => {
    // 先列出所有会话 ID 用于清理草稿
    const conversationIds = (services.conversationService?.listConversations() ?? []).map((c) => c.id)
    await services.conversationService?.removeAllConversations()
    for (const id of conversationIds) {
      services.settingsRepository?.remove(`draft_${id}`)
    }
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

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_CODEX_SEARCH_MODE, async (_event, id: string, mode: 'hosted' | 'standalone'): Promise<void> => {
    await services.conversationService?.updateCodexSearchMode(id, mode)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_SEARCH_ENGINE, async (_event, id: string, engine: 'bing' | 'baidu' | 'google'): Promise<void> => {
    await services.conversationService?.updateSearchEngine(id, engine)
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
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, id: string, text: string, attachmentIds: string[] = []): Promise<{ userMessage: Message; assistantMessage: Message } | null> => {
    console.log('[IPC CHAT_SEND] id=%s text=%s attachments=%d', id, text.slice(0, 80), attachmentIds.length)
    const result = await (services.conversationService?.sendMessage(id, text, attachmentIds) ?? null)
    console.log('[IPC CHAT_SEND] result=%s', result ? `userMsg=${result.userMessage.id} assistantMsg=${result.assistantMessage.id}` : 'null')
    return result
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_INTERRUPT, async (): Promise<void> => {
    await services.conversationService?.interrupt()
  })

  // ===== Image Generation =====
  ipcMain.handle(IPC_CHANNELS.IMAGE_GENERATION_GENERATE, async (
    _event,
    conversationId: string,
    prompt: string,
    params: { size?: string | null; quality?: string | null; background?: string | null; outputFormat?: string | null },
    inputAttachmentIds: string[] = []
  ): Promise<{ userMessage: Message; assistantMessage: Message } | null> => {
    if (!services.imageGenerationService) throw new Error('image_generation_unavailable')
    return await services.imageGenerationService.generate(conversationId, prompt, params ?? {}, inputAttachmentIds)
  })

  ipcMain.handle(IPC_CHANNELS.IMAGE_GENERATION_INTERRUPT, async (): Promise<void> => {
    await services.imageGenerationService?.interrupt()
  })

  ipcMain.handle(IPC_CHANNELS.IMAGE_GENERATION_LIST, (_event, conversationId: string) => {
    return services.imageGenerationService?.listGenerations(conversationId) ?? []
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_UPDATE_IMAGE_DEFAULTS, async (
    _event,
    id: string,
    size: string | null,
    quality: string | null,
    background: string | null
  ): Promise<void> => {
    await services.conversationService?.updateImageDefaults(id, size, quality, background)
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

  // ===== Boot Theme 同步（下次冷启动首帧背景色） =====
  ipcMain.handle(IPC_CHANNELS.BOOT_SET_THEME, (_event, theme: BootTheme): void => {
    writeBootTheme(theme)
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

      // 登录成功后启动 Codex usage 自动刷新；登出时停止
      if (status === 'logged-in') {
        services.usageService?.startAutoRefresh()
        void services.usageService?.refresh()
      } else if (status === 'logged-out') {
        services.usageService?.stopAutoRefresh()
      }
    })
  }

  // ===== Events (Main -> Renderer) =====
  services.usageService?.onChange((view) => {
    const win = getMainWindow()
    if (!win) return
    win.webContents.send(IPC_CHANNELS.CODEX_USAGE_CHANGED, view)
  })

  services.imageGenerationService?.onStreamEvent((event) => {
    const win = getMainWindow()
    if (!win) return
    const e = event as { type: string }
    switch (e.type) {
      case 'image-generation-started':
        win.webContents.send(IPC_CHANNELS.IMAGE_GENERATION_STARTED, event)
        break
      case 'image-generation-completed':
        win.webContents.send(IPC_CHANNELS.IMAGE_GENERATION_COMPLETED, event)
        break
      case 'image-generation-failed':
        win.webContents.send(IPC_CHANNELS.IMAGE_GENERATION_FAILED, event)
        break
    }
  })

  services.conversationService?.onStreamEvent((event) => {
    const win = getMainWindow()
    if (!win) return

    const e = event as { type: string; conversationId?: string }

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
      case 'web-search-call-started':
        win.webContents.send(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_STARTED, event)
        break
      case 'web-search-call-completed':
        win.webContents.send(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_COMPLETED, event)
        break
      case 'web-search-call-failed':
        win.webContents.send(IPC_CHANNELS.CHAT_WEB_SEARCH_CALL_FAILED, event)
        break
      case 'stream-reset':
        win.webContents.send(IPC_CHANNELS.CHAT_STREAM_RESET, event)
        break
    }
  })
}