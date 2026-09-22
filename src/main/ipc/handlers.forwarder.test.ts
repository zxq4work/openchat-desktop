import { describe, it, expect, vi } from 'vitest'

// handlers.ts 顶层从 electron 解构多个 API（ipcMain / BrowserWindow / shell / dialog /
// clipboard / nativeImage），其依赖链还会触达 httpsClient 的 net/session、BootPreferences
// 的 app/nativeTheme。本测试只验证事件转发与解绑，全部以最小桩替代，不发起任何真实调用。
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  shell: {},
  dialog: {},
  clipboard: {},
  nativeImage: {},
  app: { getPath: () => '/tmp', whenReady: () => Promise.resolve(), on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  net: {},
  session: { defaultSession: { forceReloadProxyConfig: vi.fn(), resolveProxy: vi.fn(), closeAllConnections: vi.fn() } },
}))

import type { BrowserWindow } from 'electron'

import { bindServiceEventForwarders, type Services } from './handlers'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

// 与真实 service 行为一致的最小桩：onStreamEvent / onChange 返回 disposer，
// disposer 从内部 handler 数组移除对应 handler。emit 用于模拟 service 侧产生事件。
function makeEmitterService() {
  const handlers: Array<(event: unknown) => void> = []
  return {
    onStreamEvent(handler: (event: unknown) => void) {
      handlers.push(handler)
      return () => {
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },
    onChange(handler: (event: unknown) => void) {
      handlers.push(handler)
      return () => {
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },
    emit(event: unknown) {
      for (const h of [...handlers]) h(event)
    },
    get handlerCount() {
      return handlers.length
    },
  }
}

function makeWindow() {
  const win = { webContents: { send: vi.fn() } }
  // 测试桩不是真实 Electron BrowserWindow，仅需 webContents.send 可被观测。
  const getWin = () => win as unknown as BrowserWindow
  return { win, getWin }
}

function servicesWith(partial: Partial<Record<keyof Services, unknown>>): Services {
  return {
    appServerProcess: null,
    settingsRepository: null,
    providerConfigService: null,
    authService: null,
    modelService: null,
    conversationService: null,
    imageGenerationService: null,
    credentialManager: null,
    usageService: null,
    webSearchService: null,
    webSearchConfig: null,
    attachmentService: null,
    ...partial,
  } as unknown as Services
}

describe('bindServiceEventForwarders — single forwarder per service instance', () => {
  it('Case E: calling bind twice on the same instance does not duplicate forwarding', () => {
    const conv = makeEmitterService()
    const { win, getWin } = makeWindow()
    const services = servicesWith({ conversationService: conv })

    bindServiceEventForwarders(services, getWin)
    bindServiceEventForwarders(services, getWin)

    // 同一实例只保留一组 forwarder
    expect(conv.handlerCount).toBe(1)

    conv.emit({ type: 'delta', conversationId: 'c1', text: 'hello' })
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.CHAT_DELTA,
      { type: 'delta', conversationId: 'c1', text: 'hello' }
    )
  })

  it('rebinding to a NEW service instance disposes the previous instance', () => {
    const { win, getWin } = makeWindow()

    const convA = makeEmitterService()
    bindServiceEventForwarders(servicesWith({ conversationService: convA }), getWin)
    expect(convA.handlerCount).toBe(1)

    const convB = makeEmitterService()
    bindServiceEventForwarders(servicesWith({ conversationService: convB }), getWin)

    // 旧实例已解绑，新实例恰好一次
    expect(convA.handlerCount).toBe(0)
    expect(convB.handlerCount).toBe(1)

    convA.emit({ type: 'delta', conversationId: 'c1', text: 'stale' })
    expect(win.webContents.send).not.toHaveBeenCalled()

    convB.emit({ type: 'delta', conversationId: 'c1', text: 'fresh' })
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('forwards chat turn-completed once after rebind', () => {
    const conv = makeEmitterService()
    const { win, getWin } = makeWindow()

    bindServiceEventForwarders(servicesWith({ conversationService: conv }), getWin)
    bindServiceEventForwarders(servicesWith({ conversationService: conv }), getWin)

    conv.emit({ type: 'turn-completed', conversationId: 'c1' })
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.CHAT_TURN_COMPLETED,
      { type: 'turn-completed', conversationId: 'c1' }
    )
  })

  it('forwards image completed once after rebind, image service kept single', () => {
    const { win, getWin } = makeWindow()

    const imgA = makeEmitterService()
    bindServiceEventForwarders(servicesWith({ imageGenerationService: imgA }), getWin)
    bindServiceEventForwarders(servicesWith({ imageGenerationService: imgA }), getWin)
    expect(imgA.handlerCount).toBe(1)

    imgA.emit({ type: 'image-generation-completed', conversationId: 'c1' })
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.IMAGE_GENERATION_COMPLETED,
      { type: 'image-generation-completed', conversationId: 'c1' }
    )
  })

  it('forwards usage change once after rebind', () => {
    const usage = makeEmitterService()
    const { win, getWin } = makeWindow()

    bindServiceEventForwarders(servicesWith({ usageService: usage }), getWin)
    bindServiceEventForwarders(servicesWith({ usageService: usage }), getWin)
    expect(usage.handlerCount).toBe(1)

    usage.emit({ state: 'ok' })
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.CODEX_USAGE_CHANGED, { state: 'ok' })
  })
})
