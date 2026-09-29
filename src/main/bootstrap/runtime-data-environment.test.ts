import { describe, expect, it } from 'vitest'
import * as path from 'path'
import { createRuntimeDataEnvironment, type RuntimeHost } from './runtime-data-environment'

// 记录交互的假 host —— 不启动 Electron，验证 apply 行为与幂等。
function makeHost(opts: {
  defaultUserData: string
  isPackaged?: boolean
  nodeEnv?: string
}): {
  host: RuntimeHost
  setPathCalls: string[]
  mkdirCalls: string[]
  mkdtempCalls: string[]
} {
  const setPathCalls: string[] = []
  const mkdirCalls: string[] = []
  const mkdtempCalls: string[] = []
  const host: RuntimeHost = {
    isPackaged: opts.isPackaged ?? false,
    nodeEnv: opts.nodeEnv,
    getPath: () => opts.defaultUserData,
    setPath: (_name, value) => { setPathCalls.push(value) },
    mkdir: (p) => { mkdirCalls.push(p) },
    mkdtemp: (prefix) => { mkdtempCalls.push(prefix); return `${prefix}AbCd12` },
  }
  return { host, setPathCalls, mkdirCalls, mkdtempCalls }
}

const DEFAULT_USER_DATA = path.join('/home/user/.config', 'OpenChat')

describe('createRuntimeDataEnvironment — 应用行为', () => {
  it('production 不覆盖 userData', () => {
    const { host, setPathCalls } = makeHost({ defaultUserData: DEFAULT_USER_DATA, isPackaged: true, nodeEnv: 'production' })
    const env = createRuntimeDataEnvironment(host)
    const plan = env.configure()
    expect(plan.profile).toBe('production')
    expect(plan.shouldOverrideUserData).toBe(false)
    expect(setPathCalls).toEqual([])
  })

  it('isPackaged=true + NODE_ENV=test：profile=production，绝不 setPath、绝不 mkdtemp', () => {
    const { host, setPathCalls, mkdirCalls, mkdtempCalls } = makeHost({
      defaultUserData: DEFAULT_USER_DATA,
      isPackaged: true,
      nodeEnv: 'test',
    })
    const env = createRuntimeDataEnvironment(host)
    const plan = env.configure()
    expect(plan.profile).toBe('production')
    expect(plan.userDataPath).toBe(DEFAULT_USER_DATA)
    expect(plan.shouldOverrideUserData).toBe(false)
    expect(setPathCalls).toEqual([])
    expect(mkdirCalls).toEqual([])
    expect(mkdtempCalls).toEqual([])
  })

  it('development 覆盖为 OpenChat-dev 并先创建目录', () => {
    const { host, setPathCalls, mkdirCalls } = makeHost({ defaultUserData: DEFAULT_USER_DATA, isPackaged: false })
    const env = createRuntimeDataEnvironment(host)
    const plan = env.configure()
    expect(plan.profile).toBe('development')
    expect(plan.userDataPath).toBe(path.join('/home/user/.config', 'OpenChat-dev'))
    expect(setPathCalls).toEqual([path.join('/home/user/.config', 'OpenChat-dev')])
    expect(mkdirCalls).toEqual([path.join('/home/user/.config', 'OpenChat-dev')])
  })

  it('test（未打包）使用 mkdtemp 临时目录并覆盖 userData', () => {
    const { host, setPathCalls, mkdtempCalls } = makeHost({ defaultUserData: DEFAULT_USER_DATA, isPackaged: false, nodeEnv: 'test' })
    const env = createRuntimeDataEnvironment(host)
    const plan = env.configure()
    expect(plan.profile).toBe('test')
    expect(plan.temporary).toBe(true)
    expect(plan.userDataPath).toContain('openchat-test-')
    expect(plan.userDataPath).not.toBe(DEFAULT_USER_DATA)
    expect(mkdtempCalls.length).toBe(1)
    expect(setPathCalls.length).toBe(1)
  })

  it('4) configure 重复执行：路径一致、不产生 OpenChat-dev-dev、只 setPath 一次', () => {
    const { host, setPathCalls, mkdtempCalls } = makeHost({ defaultUserData: DEFAULT_USER_DATA, isPackaged: false })
    const env = createRuntimeDataEnvironment(host)

    const first = env.configure()
    const second = env.configure()
    const third = env.configure()

    expect(first.userDataPath).toBe(second.userDataPath)
    expect(second.userDataPath).toBe(third.userDataPath)
    expect(first.userDataPath).toBe(path.join('/home/user/.config', 'OpenChat-dev'))
    expect(first.userDataPath).not.toContain('OpenChat-dev-dev')
    // 幂等：只应用一次
    expect(setPathCalls).toEqual([path.join('/home/user/.config', 'OpenChat-dev')])
    expect(mkdtempCalls).toEqual([])
  })

  it('getPlan / getProfile 在 configure 前为 null', () => {
    const { host } = makeHost({ defaultUserData: DEFAULT_USER_DATA })
    const env = createRuntimeDataEnvironment(host)
    expect(env.getPlan()).toBeNull()
    expect(env.getProfile()).toBeNull()
    env.configure()
    expect(env.getProfile()).toBe('development')
  })
})
