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
import { APP_NAME, APP_TITLE, MIN_SPLASH_TOTAL_VISIBLE_MS, SPLASH_FADE_MS, SERVICE_INIT_TIMEOUT_MS, SERVICE_INIT_STAGE_WARN_MS } from '../../shared/constants'
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
import { AttachmentRepository } from '../storage/AttachmentRepository'
import { AttachmentService } from '../services/attachments/AttachmentService'
import { ImageGenerationRepository } from '../storage/ImageGenerationRepository'
import { ImageGenerationService } from '../image-generation/ImageGenerationService'
import { registerAttachmentScheme, registerAttachmentProtocol } from './AttachmentProtocol'
import { getBootBackgroundColor } from './BootPreferences'

// 必须在 app ready 之前注册 custom scheme（Electron 对调用时机有要求）
registerAttachmentScheme()

// ── 启动日志 ──
const bootStartNs = process.hrtime.bigint()
function bootMs(): number { return Number((process.hrtime.bigint() - bootStartNs) / BigInt(1_000_000)) }
function bootLog(msg: string): void { console.log(`[boot +${bootMs()}ms] ${msg}`) }

// 初始化阶段计时：begin / done / error 三态日志，耗时超过软阈值额外打印 [init-warn]。
// 用于定位「services 初始化到底卡在哪个阶段」——不再只记录最终状态。
async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now()
  bootLog(`init:${name} begin`)
  try {
    const result = await fn()
    const ms = Math.round(performance.now() - t0)
    bootLog(`init:${name} done ${ms}ms`)
    if (ms > SERVICE_INIT_STAGE_WARN_MS) {
      console.warn(`[init-warn +${bootMs()}ms] init:${name} took ${ms}ms (> ${SERVICE_INIT_STAGE_WARN_MS}ms)`)
    }
    return result
  } catch (err) {
    const ms = Math.round(performance.now() - t0)
    console.error(`[boot +${bootMs()}ms] init:${name} error after ${ms}ms:`, err)
    throw err
  }
}

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
// 完成条件 latch：一旦成立即持续为 true，供 Renderer 拉取状态时判断可结束。
let bootCanFinish = false
// Renderer 已显式声明 BOOT_FINISH_SPLASH listener 注册完毕（BOOT_RENDERER_READY）。
// 只有该标记为 true 才会真正发出 finish —— 保证 send 时间不早于 listener register。
let rendererMayHandleFinish = false
// Renderer 已确认完成 Splash（ACK）。用于停止 resend 兜底，避免无意义重发。
let rendererFinishAcked = false
// resend 兜底 timer：首次 send 后若未收到 ACK，补发一次。
let splashResendTimer: ReturnType<typeof setTimeout> | null = null
// 初始化错误态（持久）：与 bootCanFinish 同理，错误 push 也可能早于 Renderer listener，
// 因此存入状态并由 BOOT_GET_STATE 一并返回，使 Renderer 无论何时拉取都能进入降级界面。
let pendingInitError: { timedOut: boolean; message: string } | null = null
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
  attachmentService: null as AttachmentService | null,
  imageGenerationService: null as ImageGenerationService | null,
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
  await stage('apply-proxy', () => applyProxyMode())

  const useMock = process.env.OPENCHAT_PROVIDER_MOCK === 'true'

  const { credentialManager, oauthClient, codexClient } = await stage('clients', () => createClients(useMock, credentialStore))
  services.credentialManager = credentialManager

  const provider = new ChatGPTSubscriptionProvider(
    credentialManager,
    oauthClient,
    codexClient
  )
  // 关键：只在阻塞路径上「加载凭证」，不在此处强制网络刷新 token。
  // 旧版本凭证缺 email/planType/userId 时的强制刷新是网络操作（首次安装 / 冷启动含 token 刷新），
  // 若挂在 Splash 阻塞链路上会导致长时间卡 Splash。改为后台补齐（见 scheduleBackgroundCredentialRefresh）。
  await stage('provider-init', () => provider.initialize({ deferTokenRefresh: true }))

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

  // 附件服务：userData/attachments 目录 + message_attachments 表
  const attachmentsDir = path.join(app.getPath('userData'), 'attachments')
  const attachmentRepository = new AttachmentRepository(storage)
  const attachmentService = new AttachmentService(attachmentsDir, attachmentRepository)
  services.attachmentService = attachmentService
  registerAttachmentProtocol(attachmentService)

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
  services.chatgptConversationService.setAttachmentService(attachmentService)
  services.conversationService = services.chatgptConversationService as unknown as ConversationService

  // 图片生成服务：独立协议（POST /v1/images/generations），与 Chat 完全隔离
  const imageGenerationRepository = new ImageGenerationRepository(storage)
  const imageGenerationService = new ImageGenerationService(storage, providerConfigService)
  imageGenerationService.setAttachmentService(attachmentService)
  services.imageGenerationService = imageGenerationService
  // 会话删除时同步清理 image_generations
  services.chatgptConversationService.setImageGenerationRepository(imageGenerationRepository)

  // 清理孤儿附件（引用了不存在会话的草稿，如发送前崩溃残留）
  await stage('orphan-cleanup', () => {
    try {
      const validIds = new Set((services.chatgptConversationService!.listConversations() ?? []).map((c) => c.id))
      attachmentService.cleanupOrphans(validIds)
    } catch (err) {
      console.error('[AttachmentService] orphan cleanup failed:', err)
    }
  })

  // usage 查询与 token 刷新均为网络操作，且不是 UI 首帧所必需：
  // 全部移出 Splash 阻塞链路，改为后台执行，避免「卡启动 loading」。
  scheduleBackgroundCredentialRefresh(credentialManager)
  scheduleBackgroundUsageRefresh(credentialManager, usageService)
}

// 后台补齐旧版本凭证缺失的 ID Token 字段（网络刷新）。失败不阻塞、不影响 UI。
function scheduleBackgroundCredentialRefresh(credentialManager: OAuthCredentialManager): void {
  void stage('bg:credential-refresh', () => credentialManager.ensureProfile()).catch(() => {
    // 后台刷新失败保留现有凭证即可
  })
}

// 后台 usage 查询：仅在已登录时执行（自定义服务场景下无需 Codex usage）。
// isLoggedIn 也可能触发网络刷新，因此同样放在后台，不阻塞 Splash。
function scheduleBackgroundUsageRefresh(credentialManager: OAuthCredentialManager, usageService: ChatGPTUsageService): void {
  void stage('bg:usage-refresh', async () => {
    const isLoggedIn = await credentialManager.isLoggedIn().catch(() => false)
    if (isLoggedIn) {
      void usageService.refresh()
      usageService.startAutoRefresh()
    }
  }).catch(() => { /* 后台失败忽略 */ })
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
  await stage('storage', async () => {
    const dbPath = path.join(app.getPath('userData'), 'data', 'openchat.db')
    const storage = new StorageService(dbPath)
    await storage.init()
    services.storage = storage
  })

  const provider = process.env.OPENCHAT_PROVIDER ?? 'chatgpt'

  if (provider === 'appserver') {
    await stage('appserver-provider', () => initializeAppServerProvider())
  } else {
    await stage('chatgpt-provider', () => initializeChatGPTProvider())
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
  // 持久握手状态（每个 MainWindow 生命周期）
  bootCanFinish = false
  rendererMayHandleFinish = false
  rendererFinishAcked = false
  pendingInitError = null
}

// 完成条件已成立的持久标记（latch）。
// 一旦为 true 就不再回落，使 Renderer 无论何时拉取状态都能得到「可以结束 Splash」。
// 关键：sendFinishSplash 只在 bootCanFinish 与 rendererMayHandleFinish 同时为 true 时才发送 ——
// 从根上消除「Main 早于 Renderer listener 注册就发一次性 IPC，消息丢失后永久卡 Splash」。
function markBootCanFinish(reason: string): void {
  if (bootCanFinish) return
  bootCanFinish = true
  bootLog(`bootCanFinish=true latch (${reason})`)
}

// 幂等发送：可被 hold timer / RendererReady / GetState 多次调用。
// 返回值仅用于日志；不抛异常。
function sendFinishSplash(trigger: string): void {
  if (rendererFailed) {
    bootLog(`splash finish skipped (${trigger}): rendererFailed`)
    return
  }
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    bootLog(`splash finish skipped (${trigger}): no window`)
    return
  }
  // 完成条件未成立：不发送，等 latch 成立后再发。
  if (!bootCanFinish) {
    bootLog(`splash finish deferred (${trigger}): bootCanFinish=false`)
    return
  }
  // Renderer 尚未声明 listener 已注册：推迟发送，确保不早于 listener 注册。
  // 这不是失败 —— Renderer 之后会通过 BOOT_RENDERER_READY / BOOT_GET_STATE 触发重发。
  if (!rendererMayHandleFinish) {
    bootLog(`splash finish deferred (${trigger}): renderer listener not ready`)
    return
  }

  if (!splashFinishSent) {
    splashFinishSent = true
    bootLog(`splash finish sent (${trigger}, first)`)
  } else {
    bootLog(`splash finish re-sent (${trigger}, idempotent)`)
  }
  clearSplashHoldTimer()
  clearSplashFallbackTimer()
  clearOpacityGateWatchdog()
  win.webContents.send(IPC_CHANNELS.BOOT_FINISH_SPLASH)

  // resend 兜底：即使已发生过一次 push 而 Renderer 因时序错过（同一帧内 listener 尚未 attach），
  // 也在稍后补发一次，并由 Renderer 的 ACK / GET_STATE 收敛。finish 幂等，重复发送安全。
  if (splashResendTimer) { clearTimeout(splashResendTimer); splashResendTimer = null }
  splashResendTimer = setTimeout(() => {
    splashResendTimer = null
    if (rendererFinishAcked) return
    if (rendererFailed) return
    const w = mainWindow
    if (!w || w.isDestroyed()) return
    bootLog('splash finish re-sent (ack timeout)')
    w.webContents.send(IPC_CHANNELS.BOOT_FINISH_SPLASH)
  }, 1000)
}

// 完成条件评估（幂等）：满足后 latch bootCanFinish，并按 Splash 视觉时长安排发送。
// Renderer 条件：APP_READY 正常到达 OR 兜底已触发（作为可结束的许可，而非「已就绪」的断言）。
function tryScheduleSplashFinish(): void {
  if (rendererFailed) return
  if (!servicesReady) return
  if (splashShownTs === null) return
  if (!appReadyReceived && !rendererReadyFallbackElapsed) return

  if (bootCanFinish) return
  const elapsed = performance.now() - splashShownTs
  bootLog(
    `finish conditions met appReady=${appReadyReceived} fallback=${rendererReadyFallbackElapsed} ` +
    `servicesReady=${servicesReady} splashElapsed=${Math.round(elapsed)}ms listenerReady=${rendererMayHandleFinish}`
  )
  markBootCanFinish('conditions')
  scheduleFinishSend()
}

// 按 Splash 目标视觉时长安排一次幂等发送（只安排一次）。
function scheduleFinishSend(): void {
  if (!bootCanFinish) return
  if (splashFinishScheduled) return
  if (splashShownTs === null) return

  const elapsed = performance.now() - splashShownTs
  const remainingHoldMs = Math.max(0, SPLASH_HOLD_BEFORE_FADE_MS - elapsed)
  splashFinishScheduled = true
  bootLog(`splash hold=${Math.round(remainingHoldMs)}ms before send`)

  if (remainingHoldMs === 0) {
    sendFinishSplash('hold')
  } else {
    splashHoldTimer = setTimeout(() => { splashHoldTimer = null; sendFinishSplash('hold') }, remainingHoldMs)
  }
}

// 初始化失败 / 超时的统一处理：进入「主界面错误态」而非无限 Splash。
// 通过 IPC 推送 BOOT_INIT_ERROR，让 Renderer 结束 Splash 并展示错误 + 「重试初始化」按钮。
function handleInitFailure(err: unknown, timedOut = false): void {
  console.error('OpenChat initialization failed:', err)
  clearSplashHoldTimer()
  clearSplashFallbackTimer()
  clearOpacityGateWatchdog()

  const message = err instanceof Error ? err.message : String(err)
  bootLog(`init-error pushed (timedOut=${timedOut}): ${message}`)

  // 持久化错误态：push 可能早于 Renderer listener，因此同样存入状态供 get-state 拉取。
  pendingInitError = { timedOut, message }

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    // 允许 Renderer 结束 Splash（进入错误界面），并推送错误详情。
    // rendererMayHandleFinish 未必已置位，但错误态同样需要结束 Splash —— 这里直接发送，
    // Renderer 侧的错误界面监听在 App 挂载后注册，配合 BOOT_GET_STATE 拉取可自愈。
    rendererMayHandleFinish = true
    bootCanFinish = true
    mainWindow.webContents.send(IPC_CHANNELS.BOOT_FINISH_SPLASH)
    mainWindow.webContents.send(IPC_CHANNELS.BOOT_INIT_ERROR, pendingInitError)
  } else {
    // 极端情况：窗口尚未创建 —— 退化为原生错误框
    dialog.showErrorBox('启动失败', `OpenChat Desktop 初始化失败，请重试。\n${message}`)
  }
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

// ── Renderer 双向握手 ──
// sender 校验统一前置：只接受当前 mainWindow 的信号，避免旧窗口残留。
function isCurrentWindowSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
}

// BOOT_RENDERER_READY：Renderer 显式声明「BOOT_FINISH_SPLASH listener 已注册」。
// 不再依赖固定 5 秒推测 Renderer 已准备好 —— 这是消除 send 早于 listener 注册的关键。
ipcMain.on(IPC_CHANNELS.BOOT_RENDERER_READY, (event) => {
  if (!isCurrentWindowSender(event)) return
  if (rendererMayHandleFinish) return
  rendererMayHandleFinish = true
  bootLog('renderer ready (finish listener registered)')
  // listener 已就绪：若完成条件早已成立（latch 已置位），立即补发，而不必等待 hold timer。
  if (bootCanFinish) {
    bootLog('renderer ready: bootCanFinish already latched → sending finish now')
    scheduleFinishSend()
    sendFinishSplash('renderer-ready')
  }
})

// BOOT_GET_STATE：Renderer 主动拉取当前 boot 状态。
// 持久状态 + 拉取路径：即便错过所有 push（finish / init-error / services-ready），
// Renderer 也能据返回状态立即收敛 Splash 并决定是否 hydrate 数据。
ipcMain.handle(IPC_CHANNELS.BOOT_GET_STATE, (event): { canFinish: boolean; rendererFailed: boolean; servicesReady: boolean; initError: { timedOut: boolean; message: string } | null } => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return { canFinish: false, rendererFailed: false, servicesReady: false, initError: null }
  }
  bootLog(`boot get-state: canFinish=${bootCanFinish} sent=${splashFinishSent} ack=${rendererFinishAcked} servicesReady=${servicesReady} initError=${pendingInitError ? 'yes' : 'no'}`)
  // 拉取本身也视为 Renderer 已就绪（listener 必已注册后才可能调用）。
  if (!rendererMayHandleFinish) {
    rendererMayHandleFinish = true
    bootLog('renderer ready (implicit via get-state)')
  }
  if (bootCanFinish) {
    sendFinishSplash('get-state')
  }
  return { canFinish: bootCanFinish, rendererFailed, servicesReady, initError: pendingInitError }
})

// BOOT_FINISH_ACK：Renderer 完成 Splash 切换后的确认。仅用于停止 resend，不改变完成条件。
ipcMain.on(IPC_CHANNELS.BOOT_FINISH_ACK, (event) => {
  if (!isCurrentWindowSender(event)) return
  if (rendererFinishAcked) return
  rendererFinishAcked = true
  if (splashResendTimer) { clearTimeout(splashResendTimer); splashResendTimer = null }
  bootLog('renderer finish ack')
})

// BOOT_RETRY_INIT：错误态下用户点击「重试初始化」。
// 重新执行 services 初始化；成功则回到正常 boot 流程（latch 已成立，Renderer 会拉到 canFinish=true）。
ipcMain.handle(IPC_CHANNELS.BOOT_RETRY_INIT, async (event): Promise<{ ok: boolean; message?: string }> => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return { ok: false, message: '无效窗口' }
  }
  bootLog('retry-init requested')
  // 并发保护：若底层 attempt 仍在运行（如首次超时后其实未失败），绝不启动第二个 attempt，
  // 而是复用现有 attempt —— 从根上杜绝双初始化并发 / 双 markServicesReady。
  if (initInFlight) {
    bootLog('retry-init: attempt already in flight; awaiting it (no new attempt)')
    const r = await initInFlight
    if (r.ok) return { ok: true }
    const message = r.error instanceof Error ? r.error.message : String(r.error ?? '初始化失败')
    pendingInitError = { timedOut: false, message }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.BOOT_INIT_ERROR, pendingInitError)
    }
    return { ok: false, message }
  }
  // 已成功：直接返回（幂等）。
  if (servicesBuilt) {
    bootLog('retry-init: services already built')
    return { ok: true }
  }

  // 无 in-flight attempt（确认此前已失败）：清理半初始化状态，然后启动全新 attempt。
  recoverPartialServices()
  const { outcome, error } = await awaitServicesForBoot()
  if (outcome === 'ok') {
    bootLog('retry-init succeeded; services ready')
    return { ok: true }
  }
  const timedOut = outcome === 'timeout'
  const message = timedOut
    ? `services 初始化超时（> ${SERVICE_INIT_TIMEOUT_MS}ms）`
    : (error instanceof Error ? error.message : String(error ?? '初始化失败'))
  console.error('retry-init failed:', error ?? message)
  pendingInitError = { timedOut, message }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.BOOT_INIT_ERROR, pendingInitError)
  }
  return { ok: false, message }
})

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

// services 初始化：单飞（single-flight）+ 真正的 attempt 语义。
// - servicesBuilt 为「持久成功 latch」：一旦全部阶段成功即不再重跑。
// - initInFlight 为「当前 in-flight attempt」：只要底层 attempt 尚未 settle 就保持非空。
//   并发调用（如超时后底层仍在跑时用户点 Retry）一律复用它，**绝不**发起第二个 attempt。
//
// 为什么不引入 attemptId 代际号：因为本设计「超时不释放单飞锁」。上层超时只影响 UX（进入错误页），
// 底层 attempt 继续跑并最终自行 notify；因此任何时刻至多存在一个 attempt，不存在「旧 attempt 覆盖新状态」
// 的可能，代际号是多余的。反过来说：若在超时时释放锁，就必然需要代际号 —— 那正是要避免的危险设计。
let servicesBuilt = false
let initInFlight: Promise<{ ok: boolean; error?: unknown }> | null = null

// 一个 attempt 的完整初始化。
async function runInitAttempt(): Promise<void> {
  await initializeServices()
}

// 保证 services 构建完成的单一入口。返回 Promise 永不 reject（结果对象携带 ok/error），
// 避免超时后无人 await 导致的 unhandledRejection。
//  - 已成功 → 立即返回 { ok: true }
//  - 有 in-flight attempt → 复用同一 Promise（并发去重）
//  - 否则 → 启动新 attempt；其 settle（成功或失败）后才清空 initInFlight，使 Retry 得到全新 attempt
async function ensureServicesReady(): Promise<{ ok: boolean; error?: unknown }> {
  if (servicesBuilt) {
    bootLog('services already built; skipping init')
    return { ok: true }
  }
  if (initInFlight) {
    bootLog('services init already in flight; awaiting existing attempt (no new attempt)')
    return initInFlight
  }

  bootLog('services init attempt begin')
  const attempt: Promise<{ ok: boolean; error?: unknown }> = runInitAttempt()
    .then(() => {
      servicesBuilt = true
      markServicesReady('init-success')
      return { ok: true }
    })
    .catch((err) => {
      bootLog(`services init attempt failed: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: err }
    })
    .finally(() => {
      // 仅在底层 attempt 真正 settle 后释放单飞锁 —— 超时不影响此释放。
      if (initInFlight === attempt) initInFlight = null
    })

  initInFlight = attempt
  return attempt
}

// 启动时的服务等待：施加硬超时用于 UX（超时即进入错误页），但**不**释放单飞锁。
// 超时后底层 attempt 仍在跑；若其最终成功，markServicesReady 会推送 services-ready 使界面自愈。
async function awaitServicesForBoot(): Promise<{ outcome: 'ok' | 'failed' | 'timeout'; error?: unknown }> {
  const attempt = ensureServicesReady()
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<{ ok: false; error?: unknown }>((resolve) => {
    timeoutHandle = setTimeout(() => { timedOut = true; resolve({ ok: false }) }, SERVICE_INIT_TIMEOUT_MS)
  })
  // attempt 永不 reject，故 race 结果统一为 { ok, error? }
  const result = await Promise.race([attempt, timeout])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (timedOut) {
    bootLog('services init timeout (attempt continues in background; lock retained)')
    return { outcome: 'timeout' }
  }
  return result.ok ? { outcome: 'ok' } : { outcome: 'failed', error: result.error }
}

// 重试前的半初始化清理：一次失败的 attempt 可能已构建部分 services（如 storage 已 open 但
// provider 阶段 throw）。若不清理，重试会复用这些半初始化对象 —— 尤其是 StorageService 的 db handle，
// 可能出现「已 open 却缺少完整 schema」的损坏状态。
// 这里只做安全清理：清空 services 引用 + close 半初始化 DB，随后由全新 attempt 重建。
function recoverPartialServices(): void {
  if (servicesBuilt) return
  bootLog('recoverPartialServices: clearing partial init state')
  // close DB handle（若存在），避免 sql.js 数据库内存/句柄泄漏与重复 open 冲突
  try { services.storage?.close() } catch (err) { console.error('[recover] storage close failed:', err) }
  services.storage = null
  services.settingsRepository = null
  services.credentialManager = null
  services.chatgptProvider = null
  services.authService = null
  services.modelService = null
  services.usageService = null
  services.toolRegistry = null
  services.webSearchService = null
  services.webFetchService = null
  services.providerConfigRepository = null
  services.providerConfigService = null
  services.attachmentService = null
  services.chatgptConversationService = null
  services.conversationService = null
  services.imageGenerationService = null
}

// services 真正就绪的单一出口：置 servicesReady、通知 Renderer hydrate 数据、推进 Splash。
// 幂等：重复调用不会重复推送 hydrate 事件。
function markServicesReady(reason: string): void {
  bootLog(`markServicesReady (${reason})`)
  servicesReady = true
  // 清除持久错误态（错误态下 Retry 成功时）。
  pendingInitError = null
  // 通知 Renderer：Main 数据层就绪，应立即（重新）加载会话列表等数据。
  // 用 push + 短延时补发：Renderer 若在错误页/尚未挂载，可通过 getBootState().servicesReady 拉取。
  notifyRendererHydrate()
  tryScheduleSplashFinish()
}

// services-ready 推送：连续两次短间隔发送，降低单次丢失风险；Renderer 侧另有 pull 兜底。
function notifyRendererHydrate(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    bootLog('services-ready push skipped: no window')
    return
  }
  bootLog('services-ready push (hydrate signal)')
  win.webContents.send(IPC_CHANNELS.BOOT_SERVICES_READY)
  setTimeout(() => {
    const w = mainWindow
    if (!w || w.isDestroyed()) return
    w.webContents.send(IPC_CHANNELS.BOOT_SERVICES_READY)
  }, 500)
}

app.whenReady().then(async () => {
  createWindow()

  const bootstrapRenderer = () => {
    registerIpcHandlers(services, () => mainWindow)
    Menu.setApplicationMenu(null)
  }

  // 先注册 IPC handlers，保证错误界面 / 重试 / get-state 路径在任意时刻都可用。
  bootstrapRenderer()

  const { outcome, error } = await awaitServicesForBoot()
  if (outcome === 'ok') {
    // servicesReady 已在 markServicesReady 中置位；这里确保 Splash 推进（幂等）。
    tryScheduleSplashFinish()
  } else if (outcome === 'failed') {
    handleInitFailure(error, false)
  } else {
    handleInitFailure(new Error(`services 初始化超时（> ${SERVICE_INIT_TIMEOUT_MS}ms）`), true)
  }

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