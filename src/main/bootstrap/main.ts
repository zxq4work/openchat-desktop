import { app, BrowserWindow, Menu, shell } from 'electron'
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
import { APP_NAME, APP_TITLE } from '../../shared/constants'
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
import type { WebSearchEngineType } from '../../shared/types/settings'
import { WebFetchService } from '../web-search/WebFetchService'
import { ProviderConfigRepository } from '../storage/ProviderConfigRepository'
import { ProviderConfigService } from '../providers/ProviderConfigService'

let mainWindow: BrowserWindow | null = null

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
  const webSearchService = new WebSearchService(getSearchEngine(engineType))
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
    providerConfigService
  )
  services.conversationService = services.chatgptConversationService as unknown as ConversationService

  // 后台异步查询 usage，仅在已登录时执行（自定义服务场景下无需 Codex usage）
  const isLoggedIn = await credentialManager.isLoggedIn().catch(() => false)
  if (isLoggedIn) {
    void usageService.refresh()
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: APP_TITLE,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, '../../preload/index.js'),
    },
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isReloadShortcut =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'r' &&
      (input.control || input.meta)

    if (isReloadShortcut) {
      event.preventDefault()
      mainWindow?.webContents.send(IPC_CHANNELS.SHORTCUT_NEW_TOPIC)
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isNewShortcut =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'n' &&
      (input.control || input.meta)

    if (isNewShortcut) {
      event.preventDefault()
      mainWindow?.webContents.send(IPC_CHANNELS.SHORTCUT_NEW_CONVERSATION)
    }
  })

  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        event.preventDefault()
        mainWindow?.webContents.toggleDevTools()
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (currentUrl && url !== currentUrl) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) {
        shell.openExternal(url)
      }
    }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await initializeServices()
  registerIpcHandlers(services, () => mainWindow)
  Menu.setApplicationMenu(null)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  services.appServerProcess?.stop()
  services.mockAuthServer?.stop()
  services.storage?.close()
})

export { services }