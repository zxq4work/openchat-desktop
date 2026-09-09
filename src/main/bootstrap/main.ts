import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { AppServerProcess, AppServerMode } from '../openai/AppServerProcess'
import { AppServerRpcClient } from '../openai/AppServerRpcClient'
import { OpenAIAppServerClient } from '../openai/OpenAIAppServerClient'
import { AuthService } from '../openai/AuthService'
import { ModelService } from '../openai/ModelService'
import { ThreadService } from '../openai/ThreadService'
import { ChatService } from '../openai/ChatService'
import { StorageService } from '../storage/StorageService'
import { SettingsRepository } from '../storage/SettingsRepository'
import { ConversationService } from '../conversation/ConversationService'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { APP_NAME, APP_TITLE, MIN_SPLASH_TOTAL_VISIBLE_MS, SPLASH_FADE_MS } from '../../shared/constants'
import { registerIpcHandlers } from '../ipc/handlers'

// ChatGPT Direct Provider
import { ChatGPTSubscriptionProvider } from '../openai/chatgpt/ChatGPTSubscriptionProvider'
import { ChatGPTConversationService } from '../openai/chatgpt/ChatGPTConversationService'
import { OpenAIOAuthClient } from '../openai/chatgpt/auth/OpenAIOAuthClient'
import { OAuthCredentialManager } from '../openai/chatgpt/auth/OAuthCredentialManager'
import { FileOAuthCredentialStore } from '../openai/chatgpt/auth/OAuthCredentialStore'
import type { ChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { RealChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import type { OAuthClient } from '../openai/chatgpt/auth/OAuthClient'
import { setProxyConfig, applyProxyMode } from '../openai/chatgpt/httpsClient'

// Mock Provider (dev/test)
import { MockAuthServer } from '../openai/chatgpt/auth/MockAuthServer'
import { MockOAuthClient } from '../openai/chatgpt/auth/MockOAuthClient'
import { MockChatGPTCodexClient } from '../openai/chatgpt/transport/ChatGPTCodexClient'
import { fetchCodexUsage } from '../openai/chatgpt/codexUsageDiagnostics'
import { ChatGPTUsageService } from '../openai/chatgpt/usage/ChatGPTUsageService'
import { ToolRegistry } from '../tools/ToolRegistry'
import { WebSearchTool } from '../tools/WebSearchTool'
import { WebFetchTool } from '../tools/WebFetchTool'
import { WebSearchService } from '../web-search/WebSearchService'
import { getSearchEngine } from '../web-search/SearchEngineFactory'
import type { WebSearchEngineType, WebSearchConfig } from '../../shared/types/settings'
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../shared/types/settings'
import { WebFetchService } from '../web-search/WebFetchService'
import { ProviderConfigRepository } from '../storage/ProviderConfigRepository'
import { ProviderConfigService } from '../providers/ProviderConfigService'
import { getBootBackgroundColor } from './BootPreferences'

// ── 启动日志 ──
const bootStartNs = process.hrtime.bigint()
function bootMs(): number { return Number((process.hrtime.bigint() - bootStartNs) / BigInt(1_000_000)) }
function bootLog(msg: string): void { console.log(`[boot +${bootMs()}ms] ${msg}`) }

// ── Splash 参数 ──
const SPLASH_HOLD_BEFORE_FADE_MS = Math.max(0, MIN_SPLASH_TOTAL_VISIBLE_MS - SPLASH_FADE_MS)

let mainWindow: BrowserWindow | null = null
let isAppQuitting = false

// ── Splash 状态（每个 MainWindow 生命周期） ──
let splashShownTs: number | null = null
let appReadyReceived = false
let rendererReadyFallbackElapsed = false   // 5s 兜底触发，允许绕过 APP_READY 继续
let rendererFailed = false                 // renderer 加载失败/crash，禁止结束 Splash
let servicesReady = false
let splashFinishScheduled = false
let splashFinishSent = false
let splashHoldTimer: ReturnType<typeof setTimeout> | null = null
let splashFallbackTimer: ReturnType<typeof setTimeout> | null = null
let useOpacityGate = false                 // 本次 createWindow 是否使用 opacity gate
let windowShownForOpacityGate = false      // ready-to-show 后 show 已发生（opacity=0）
let opacityGateRendererReady = false       // renderer 已注册 onWindowShown listener
let opacityGateReleased = false            // 已 setOpacity(1)，防重复
let opacityGateWatchdog: ReturnType<typeof setTimeout> | null = null

const services = {
  appServerProcess: null as AppServerProcess | null,
  rpcClient: null as AppServerRpcClient | null,
  openaiClient: null as OpenAIAppServerClient | null,
  authService: null as AuthService | null,
  modelService: null as ModelService | null,
  threadService: null as ThreadService | null,
  chatService: null as ChatService | null,
  storage: null as StorageService | null,
  settingsRepository: null as SettingsRepository | null,
  conversationService: null as ConversationService | null,

  // ChatGPT Direct Provider
  chatgptProvider: null as ChatGPTSubscriptionProvider | null,
  chatgptConversationService: null as ChatGPTConversationService | null,
  credentialManager: null as OAuthCredentialManager | null,
  usageService: null as ChatGPTUsageService | null,
  mockAuthServer: null as MockAuthServer | null,

  // New architecture
  toolRegistry: null as ToolRegistry | null,
  webSearchService: null as WebSearchService | null,
  webFetchService: null as WebFetchService | null,
  providerConfigRepository: null as ProviderConfigRepository | null,
  providerConfigService: null as ProviderConfigService | null,
  webSearchConfig: null as WebSearchConfig | null,
}

function getAppServerMode(): AppServerMode {
  const explicit = process.env.OPENCHAT_APP_SERVER_MODE
  if (explicit === 'mock' || explicit === 'bundled') {
    return explicit
  }
  return process.env.NODE_ENV === 'production' ? 'bundled' : 'mock'
}

function getCodexBinaryPath(): string {
  const resourcesBinPath = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (fs.existsSync(resourcesBinPath)) {
    return resourcesBinPath
  }

  const devBinPath = path.join(__dirname, '../../../../resources', process.platform === 'win32' ? 'win/codex.exe' : 'mac/codex')
  if (fs.existsSync(devBinPath)) {
    return devBinPath
  }

  return resourcesBinPath
}

function getCodexHome(): string {
  return path.join(app.getPath('userData'), 'codex-home')
}

function getConfigPath(): string {
  return path.join(getCodexHome(), 'config.toml')
}

async function createClients(
  useMock: boolean,
  credentialStore: FileOAuthCredentialStore
): Promise<{ credentialManager: OAuthCredentialManager; oauthClient: OAuthClient; codexClient: ChatGPTCodexClient }> {
  if (useMock) {
    const mockServer = new MockAuthServer()
    await mockServer.start()
    services.mockAuthServer = mockServer

    const oauthClient = new MockOAuthClient('success')
    return {
      credentialManager: new OAuthCredentialManager(credentialStore, oauthClient),
      oauthClient,
      codexClient: new MockChatGPTCodexClient(),
    }
  }

  const oauthClient = new OpenAIOAuthClient()
  const credentialManager = new OAuthCredentialManager(credentialStore, oauthClient)
  const codexClient = new RealChatGPTCodexClient(credentialManager)

  return { credentialManager, oauthClient, codexClient }
}

async function initializeChatGPTProvider(): Promise<void> {
  const storage = services.storage!
  const settingsRepo = new SettingsRepository(storage)
  services.settingsRepository = settingsRepo
  const credentialStore = new FileOAuthCredentialStore(settingsRepo)

  // 加载持久化的代理配置
  const rawProxyConfig = settingsRepo.get('proxy_config')
  if (rawProxyConfig) {
    try {
      const proxyConfig = JSON.parse(rawProxyConfig)
      setProxyConfig(proxyConfig)
    } catch {
      // 忽略损坏的配置
    }
  }

  // 启动时应用代理模式到 Electron session（system/direct 走 Chromium）
  await applyProxyMode()

  const useMock = process.env.OPENCHAT_PROVIDER_MOCK === 'true'

  const { credentialManager, oauthClient, codexClient } = await createClients(useMock, credentialStore)
  services.credentialManager = credentialManager

  const provider = new ChatGPTSubscriptionProvider(
    credentialManager,
    oauthClient,
    codexClient
  )
  await provider.initialize()

  services.chatgptProvider = provider
  services.authService = provider.authService as unknown as AuthService
  services.modelService = provider.modelService as unknown as ModelService

  const usageService = new ChatGPTUsageService(credentialManager)
  services.usageService = usageService

  // 初始化新架构：ToolRegistry + WebSearchService + ProviderConfigService
  const toolRegistry = new ToolRegistry()

  // 读取持久化的搜索引擎设置，默认 bing
  const rawEngine = settingsRepo.get('web_search_engine')
  const engineType: WebSearchEngineType = rawEngine === 'baidu' || rawEngine === 'bing' || rawEngine === 'google' ? rawEngine : 'bing'

  // 读取持久化的搜索配置（最大结果数、最大工具轮数）
  const rawSearchConfig = settingsRepo.get('web_search_config')
  let webSearchConfig: WebSearchConfig = { ...DEFAULT_WEB_SEARCH_CONFIG }
  if (rawSearchConfig) {
    try {
      const parsed = JSON.parse(rawSearchConfig) as Partial<WebSearchConfig>
      webSearchConfig = {
        maxResults: typeof parsed.maxResults === 'number' ? parsed.maxResults : DEFAULT_WEB_SEARCH_CONFIG.maxResults,
        maxToolRounds: typeof parsed.maxToolRounds === 'number' ? parsed.maxToolRounds : DEFAULT_WEB_SEARCH_CONFIG.maxToolRounds,
      }
    } catch { /* keep default */ }
  }
  services.webSearchConfig = webSearchConfig

  const webSearchService = new WebSearchService(getSearchEngine(engineType), engineType, webSearchConfig.maxResults)
  const webFetchService = new WebFetchService()
  toolRegistry.register('openchat_web_search', new WebSearchTool(webSearchService))
  toolRegistry.register('openchat_web_fetch', new WebFetchTool(webFetchService))
  services.toolRegistry = toolRegistry
  services.webSearchService = webSearchService
  services.webFetchService = webFetchService

  const providerConfigRepository = new ProviderConfigRepository(storage)
  services.providerConfigRepository = providerConfigRepository
  const providerConfigService = new ProviderConfigService(providerConfigRepository, codexClient)
  services.providerConfigService = providerConfigService

  services.chatgptConversationService = new ChatGPTConversationService(
    storage,
    codexClient,
    provider.modelService,
    credentialManager,
    usageService,
    toolRegistry,
    webSearchService,
    providerConfigService,
    webSearchConfig
  )
  services.conversationService = services.chatgptConversationService as unknown as ConversationService

  // 后台异步查询 usage，仅在已登录时执行（自定义服务场景下无需 Codex usage）
  const isLoggedIn = await credentialManager.isLoggedIn().catch(() => false)
  if (isLoggedIn) {
    void usageService.refresh()
    usageService.startAutoRefresh()
  }
}

async function initializeAppServerProvider(): Promise<void> {
  const storage = services.storage!

  // 确保 settingsRepository 已初始化（AppServer 模式下不需要 credentialStore）
  if (!services.settingsRepository) {
    services.settingsRepository = new SettingsRepository(storage)
  }

  const mode = getAppServerMode()
  const binaryPath = getCodexBinaryPath()
  const appServerProcess = new AppServerProcess(binaryPath, getCodexHome(), getConfigPath(), mode)
  services.appServerProcess = appServerProcess

  const rpcClient = new AppServerRpcClient(appServerProcess)
  services.rpcClient = rpcClient

  const openaiClient = new OpenAIAppServerClient(rpcClient)
  services.openaiClient = openaiClient

  services.authService = new AuthService(openaiClient)
  services.modelService = new ModelService(openaiClient)
  services.threadService = new ThreadService(openaiClient)
  services.chatService = new ChatService(openaiClient)
  services.conversationService = new ConversationService(
    storage,
    services.threadService,
    services.chatService,
    services.modelService
  )

  appServerProcess.start()

  try {
    await openaiClient.initialize({
      clientInfo: {
        name: APP_NAME,
        title: APP_TITLE,
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    })
    openaiClient.initialized()
  } catch (err) {
    console.error('App Server initialize failed:', err)
  }
}

async function initializeServices(): Promise<void> {
  // Storage
  const dbPath = path.join(app.getPath('userData'), 'data', 'openchat.db')
  const storage = new StorageService(dbPath)
  await storage.init()
  services.storage = storage

  const provider = process.env.OPENCHAT_PROVIDER ?? 'chatgpt'

  if (provider === 'appserver') {
    await initializeAppServerProvider()
  } else {
    await initializeChatGPTProvider()
  }
}

// ── Splash 状态机 ──

function clearSplashHoldTimer(): void {
  if (splashHoldTimer) { clearTimeout(splashHoldTimer); splashHoldTimer = null }
}

function clearSplashFallbackTimer(): void {
  if (splashFallbackTimer) { clearTimeout(splashFallbackTimer); splashFallbackTimer = null }
}

function clearOpacityGateWatchdog(): void {
  if (opacityGateWatchdog) { clearTimeout(opacityGateWatchdog); opacityGateWatchdog = null }
}

function resetSplashBootState(): void {
  clearSplashHoldTimer()
  clearSplashFallbackTimer()
  clearOpacityGateWatchdog()
  splashShownTs = null
  appReadyReceived = false
  rendererReadyFallbackElapsed = false
  rendererFailed = false
  // servicesReady 是 App 级状态，services 只初始化一次，不随窗口重置
  splashFinishScheduled = false
  splashFinishSent = false
  useOpacityGate = false
  windowShownForOpacityGate = false
  opacityGateRendererReady = false
  opacityGateReleased = false
}

function sendFinishSplash(): void {
  if (splashFinishSent) return
  if (rendererFailed) return
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  splashFinishSent = true
  clearSplashHoldTimer()
  clearSplashFallbackTimer()
  clearOpacityGateWatchdog()
  bootLog('splash finish sent')
  win.webContents.send(IPC_CHANNELS.BOOT_FINISH_SPLASH)
}

function tryScheduleSplashFinish(): void {
  // Renderer 条件：APP_READY 正常到达 OR 5s 兜底已触发
  if (!appReadyReceived && !rendererReadyFallbackElapsed) return
  if (rendererFailed) return
  if (!servicesReady) return
  if (splashShownTs === null) return
  if (splashFinishScheduled) return

  const elapsed = performance.now() - splashShownTs
  const remainingHoldMs = Math.max(0, SPLASH_HOLD_BEFORE_FADE_MS - elapsed)

  splashFinishScheduled = true
  bootLog(`splash elapsed=${Math.round(elapsed)}ms remainingHold=${Math.round(remainingHoldMs)}ms`)

  if (remainingHoldMs === 0) {
    sendFinishSplash()
  } else {
    splashHoldTimer = setTimeout(sendFinishSplash, remainingHoldMs)
  }
}

function handleInitFailure(err: unknown): void {
  console.error('OpenChat initialization failed:', err)
  clearSplashHoldTimer()
  clearSplashFallbackTimer()
  clearOpacityGateWatchdog()
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  dialog.showErrorBox('启动失败', `OpenChat Desktop 初始化失败，请重试。\n${err}`)
}

// Renderer 加载失败 / crash / OOM / killed 时的统一处理。
// 不能调用 sendFinishSplash()——那会让 Splash 消失后露出空白窗口。
// 这里保留 Splash（或直接弹出错误框），让用户看到明确错误而非白屏。
function handleRendererFailure(reason: string): void {
  // Splash 已完成则不属于启动失败，不弹错误框（App 已正常运行后 renderer crash 由 Electron 默认处理）
  if (splashFinishSent) {
    console.error(`Renderer failure after splash finish: ${reason}`)
    return
  }
  console.error(`Renderer failure: ${reason}`)

  // 不再结束 Splash，避免白屏。清理 Splash 相关 timer，防止后续误触发。
  clearSplashHoldTimer()
  clearSplashFallbackTimer()
  clearOpacityGateWatchdog()

  // 标记 renderer 已失败，使任何后续 tryScheduleSplashFinish 不再推进
  rendererFailed = true

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  dialog.showErrorBox('渲染进程异常', `OpenChat 界面加载失败，请重启应用。\n${reason}`)
}

// ── APP_READY handler（全局只注册一次） ──

function handleAppReady(event: Electron.IpcMainEvent): void {
  // 校验 sender 是当前 mainWindow 的 webContents，避免旧窗口残留信号
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return
  }
  if (appReadyReceived) return
  appReadyReceived = true
  bootLog('app ready')
  tryScheduleSplashFinish()
}

// 全局只注册一次，不随 MainWindow 创建而重复注册
ipcMain.on(IPC_CHANNELS.APP_READY, handleAppReady)

// BOOT_SPLASH_PAINTED：Renderer 在 opacity=0 窗口里完成 Splash 首帧 paint 后发送。
// 收到后 setOpacity(1) 让 Splash 真正可见，然后记录 splashShownTs 开始计时。
ipcMain.on(IPC_CHANNELS.BOOT_SPLASH_PAINTED, (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  if (!useOpacityGate) return
  if (opacityGateReleased) return
  if (rendererFailed) return

  opacityGateReleased = true
  clearOpacityGateWatchdog()

  mainWindow.setOpacity(1)
  splashShownTs = performance.now()
  bootLog('splash visible (opacity gate released)')
  tryScheduleSplashFinish()
})

// BOOT_OPACITY_GATE_READY：renderer 已注册好 onWindowShown listener，握手完成一半
ipcMain.on(IPC_CHANNELS.BOOT_OPACITY_GATE_READY, (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  if (!useOpacityGate) return
  if (opacityGateRendererReady) return

  opacityGateRendererReady = true
  bootLog('opacity gate renderer ready')
  tryNotifyOpacityGateWindowShown()
})

function tryNotifyOpacityGateWindowShown(): void {
  if (!useOpacityGate) return
  if (!windowShownForOpacityGate) return
  if (!opacityGateRendererReady) return
  if (opacityGateReleased) return

  const win = mainWindow
  if (!win || win.isDestroyed()) return

  win.webContents.send(IPC_CHANNELS.BOOT_WINDOW_SHOWN)
  bootLog('opacity gate window-shown sent')
}

// ── 窗口创建 ──

function createWindow(): void {
  resetSplashBootState()

  const backgroundColor = getBootBackgroundColor()

  // 诊断：opacity=0 消除 show/compositor 交接白闪
  useOpacityGate = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    title: APP_TITLE, show: false, backgroundColor, autoHideMenuBar: true,
    opacity: useOpacityGate ? 0 : 1,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      preload: path.join(__dirname, '../../preload/index.js'),
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (useOpacityGate) {
      windowShownForOpacityGate = true
      bootLog('window shown (opacity gate)')
      tryNotifyOpacityGateWindowShown()
    }
  })

  // 非 opacity gate 时，show 事件即 Splash 真正可见
  if (!useOpacityGate) {
    mainWindow.once('show', () => {
      splashShownTs = performance.now()
      bootLog('window shown')
      tryScheduleSplashFinish()
    })
  }

  // macOS 关闭窗口时改为 hide，而非 destroy。
  // 这样 Dock 再次点击时直接 show 原窗口，不重新 createWindow / load / mount。
  // Cmd+Q 或 before-quit 时 isAppQuitting=true，放行真正的销毁。
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isAppQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      bootLog('window hidden (macOS close → hide)')
    }
  })

  // 5 秒兜底：APP_READY 信号异常时绕过 Renderer 条件继续。
  // 不直接 sendFinishSplash——仅标记 fallback 已触发，然后走 tryScheduleSplashFinish。
  // 若此时 services 尚未 ready，标记保留，services 完成后 trySchedule 会自然推进。
  // 注意：rendererFailed 时不会推进（tryScheduleSplashFinish 中有守卫）。
  splashFallbackTimer = setTimeout(() => {
    splashFallbackTimer = null
    const win = mainWindow
    if (!win || win.isDestroyed() || splashFinishSent || rendererFailed) return
    rendererReadyFallbackElapsed = true
    bootLog('5s fallback: renderer condition bypassed')
    tryScheduleSplashFinish()
  }, 5000)

  // opacity gate watchdog：防止握手失败导致窗口永久透明。
  if (useOpacityGate) {
    opacityGateWatchdog = setTimeout(() => {
      opacityGateWatchdog = null
      if (opacityGateReleased || rendererFailed) return
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      console.error('[boot] opacity gate timeout, releasing gate')
      opacityGateReleased = true
      win.setOpacity(1)
      if (splashShownTs === null) {
        splashShownTs = performance.now()
      }
      tryScheduleSplashFinish()
    }, 3000)
  }

  // Renderer 加载失败：页面无法加载时触发。仅处理 main frame，并过滤 ERR_ABORTED(-3)
  // 等非真实加载失败（如用户主动取消、导航中断等）。
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    // ERR_ABORTED(-3): 页面导航被取消（如 loadFile 前 loadURL 被中断），非真实错误
    if (errorCode === -3) return
    bootLog(`renderer did-fail-load: ${errorCode} ${errorDescription}`)
    handleRendererFailure(`页面加载失败 (${errorCode}: ${errorDescription})`)
  })

  // Renderer 进程 crash / killed / OOM。正常退出时忽略。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (isAppQuitting) return
    bootLog(`renderer render-process-gone: reason=${details.reason}`)
    handleRendererFailure(`渲染进程异常 (${details.reason})`)
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'r' && (input.control || input.meta)) {
      event.preventDefault()
      mainWindow?.webContents.send(IPC_CHANNELS.SHORTCUT_NEW_TOPIC)
    }
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'n' && (input.control || input.meta)) {
      event.preventDefault()
      mainWindow?.webContents.send(IPC_CHANNELS.SHORTCUT_NEW_CONVERSATION)
    }
  })

  // 临时允许 F12 打开 DevTools 查看性能日志（含生产构建，测试完还原为 !app.isPackaged）
  {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        event.preventDefault(); mainWindow?.webContents.toggleDevTools()
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) { shell.openExternal(url) }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (currentUrl && url !== currentUrl) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) { shell.openExternal(url) }
    }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) { mainWindow.loadURL(devServerUrl) }
  else { mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html')) }
}

// ── 应用入口 ──

app.whenReady().then(async () => {
  createWindow()
  try {
    await initializeServices()
    registerIpcHandlers(services, () => mainWindow)
    Menu.setApplicationMenu(null)
    servicesReady = true
    bootLog('services ready')
    tryScheduleSplashFinish()
  } catch (err) { handleInitFailure(err); return }

  app.on('activate', () => {
    // macOS Dock 点击 — 如果已有主窗口则显示，否则恢复（不重播 Splash）
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS 隐藏窗口时不会触发此事件（close→hide 被 preventDefault 了），
  // 真正 quit 时才会走到这里（isAppQuitting=true，窗口正常销毁）
  if (process.platform !== 'darwin') app.quit()
})

app.on('browser-window-created', (_event, window) => {
  window.on('closed', () => {
    if (window === mainWindow) {
      clearSplashHoldTimer()
      clearSplashFallbackTimer()
      clearOpacityGateWatchdog()
      mainWindow = null
    }
  })
})

app.on('will-quit', () => { services.appServerProcess?.stop(); services.mockAuthServer?.stop(); services.storage?.close() })

app.on('before-quit', () => {
  isAppQuitting = true
})

export { services }