import { ipcMain, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { PublicAccountInfo } from '../../shared/types/account'
import type { ModelInfo } from '../../shared/types/model'
import type { Conversation, ContextSegment, Message } from '../../shared/types/conversation'
import type { ProxyConfig } from '../../shared/types/settings'
import { setProxyConfig } from '../openai/chatgpt/httpsClient'

interface Services {
  appServerProcess: { isRunning: boolean } | null
  settingsRepository: {
    get: (key: string) => string | null
    set: (key: string, value: string) => void
    remove: (key: string) => void
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
    createConversation: (modelId: string | null, effort: string | null, systemPrompt?: string) => Conversation
    renameConversation: (id: string, title: string) => void
    removeConversation: (id: string) => Promise<void>
    updateRole: (id: string, prompt: string) => void
    updateModel: (id: string, modelId: string) => Promise<void>
    updateEffort: (id: string, effort: string) => Promise<void>
    updateUseModelInstructions: (id: string, useModelInstructions: boolean) => Promise<void>
    newTopic: (id: string) => ContextSegment | null
    sendMessage: (id: string, text: string) => Promise<void>
    interrupt: () => Promise<void>
    onStreamEvent: (handler: (event: unknown) => void) => void
  } | null
}

export function registerIpcHandlers(services: Services): void {
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

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET_PROXY, (_event, config: ProxyConfig): void => {
    services.settingsRepository?.set('proxy_config', JSON.stringify(config))
    setProxyConfig(config)
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

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_CREATE, (_event, modelId: string | null, effort: string | null, systemPrompt?: string): Conversation | null => {
    return services.conversationService?.createConversation(modelId, effort, systemPrompt) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_RENAME, (_event, id: string, title: string): void => {
    services.conversationService?.renameConversation(id, title)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_REMOVE, async (_event, id: string): Promise<void> => {
    await services.conversationService?.removeConversation(id)
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

  ipcMain.handle(IPC_CHANNELS.CONVERSATIONS_NEW_TOPIC, (_event, id: string): ContextSegment | null => {
    return services.conversationService?.newTopic(id) ?? null
  })

  // ===== Chat =====
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, id: string, text: string): Promise<void> => {
    await services.conversationService?.sendMessage(id, text)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_INTERRUPT, async (): Promise<void> => {
    await services.conversationService?.interrupt()
  })

  // ===== Auth Events (Main -> Renderer) =====
  if (services.authService?.onStatusChange) {
    services.authService.onStatusChange((status: string) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      win.webContents.send(IPC_CHANNELS.AUTH_CHANGED, status)
    })
  }

  // ===== Events (Main -> Renderer) =====
  services.conversationService?.onStreamEvent((event) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return

    const e = event as { type: string }
    switch (e.type) {
      case 'delta':
        win.webContents.send(IPC_CHANNELS.CHAT_DELTA, event)
        break
      case 'reasoning-started':
        win.webContents.send(IPC_CHANNELS.CHAT_REASONING_STARTED, event)
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
    }
  })
}