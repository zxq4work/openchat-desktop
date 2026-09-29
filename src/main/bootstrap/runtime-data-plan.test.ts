import { describe, expect, it } from 'vitest'
import * as path from 'path'
import {
  deriveDevelopmentUserDataPath,
  resolveRuntimeDataPlan,
  resolveRuntimeProfile,
} from './runtime-data-plan'

// 使用一个与真实平台无关的“默认 userData”样本，验证推导与判定逻辑。
const DEFAULT_USER_DATA = path.join('/home/user/.config', 'OpenChat')

describe('resolveRuntimeProfile', () => {
  it('isPackaged=true 永远 production —— NODE_ENV 无权覆盖', () => {
    expect(resolveRuntimeProfile({ isPackaged: true, nodeEnv: 'test' })).toBe('production')
    expect(resolveRuntimeProfile({ isPackaged: true, nodeEnv: 'development' })).toBe('production')
    expect(resolveRuntimeProfile({ isPackaged: true, nodeEnv: undefined })).toBe('production')
    expect(resolveRuntimeProfile({ isPackaged: true, nodeEnv: 'production' })).toBe('production')
  })

  it('isPackaged=false 且 NODE_ENV=test → test', () => {
    expect(resolveRuntimeProfile({ isPackaged: false, nodeEnv: 'test' })).toBe('test')
  })

  it('isPackaged=false 且非 test → development', () => {
    expect(resolveRuntimeProfile({ isPackaged: false, nodeEnv: undefined })).toBe('development')
    expect(resolveRuntimeProfile({ isPackaged: false, nodeEnv: 'development' })).toBe('development')
  })
})

describe('deriveDevelopmentUserDataPath', () => {
  it('基于真实默认目录的同级兄弟目录，追加 -dev 后缀', () => {
    expect(deriveDevelopmentUserDataPath(DEFAULT_USER_DATA))
      .toBe(path.join('/home/user/.config', 'OpenChat-dev'))
  })
})

describe('resolveRuntimeDataPlan', () => {
  it('1) production：userData 不变，shouldOverride=false', () => {
    const plan = resolveRuntimeDataPlan({
      isPackaged: true,
      nodeEnv: 'production',
      defaultUserDataPath: DEFAULT_USER_DATA,
    })
    expect(plan.profile).toBe('production')
    expect(plan.userDataPath).toBe(DEFAULT_USER_DATA)
    expect(plan.defaultUserDataPath).toBe(DEFAULT_USER_DATA)
    expect(plan.shouldOverrideUserData).toBe(false)
    expect(plan.temporary).toBe(false)
  })

  it('1b) isPackaged=true + NODE_ENV=test：仍为 production，绝不切到临时目录', () => {
    // 即使注入了 testTempPath，也不得被采用（packaged 永远 production）。
    const plan = resolveRuntimeDataPlan({
      isPackaged: true,
      nodeEnv: 'test',
      defaultUserDataPath: DEFAULT_USER_DATA,
      testTempPath: '/tmp/openchat-test-AbCd12',
    })
    expect(plan.profile).toBe('production')
    expect(plan.userDataPath).toBe(DEFAULT_USER_DATA)
    expect(plan.userDataPath).not.toBe('/tmp/openchat-test-AbCd12')
    expect(plan.shouldOverrideUserData).toBe(false)
    expect(plan.temporary).toBe(false)
  })

  it('2) development：目标与 production 不同，且为默认目录 + -dev，shouldOverride=true', () => {
    const plan = resolveRuntimeDataPlan({
      isPackaged: false,
      nodeEnv: undefined,
      defaultUserDataPath: DEFAULT_USER_DATA,
    })
    expect(plan.profile).toBe('development')
    expect(plan.userDataPath).toBe(deriveDevelopmentUserDataPath(DEFAULT_USER_DATA))
    expect(plan.userDataPath).not.toBe(plan.defaultUserDataPath)
    expect(plan.shouldOverrideUserData).toBe(true)
    expect(plan.temporary).toBe(false)
  })

  it('3) test（未打包）：temporary=true，与 production / development 都不同', () => {
    const testTempPath = '/tmp/openchat-test-AbCd12'
    const plan = resolveRuntimeDataPlan({
      isPackaged: false,
      nodeEnv: 'test',
      defaultUserDataPath: DEFAULT_USER_DATA,
      testTempPath,
    })
    expect(plan.profile).toBe('test')
    expect(plan.temporary).toBe(true)
    expect(plan.userDataPath).toBe(testTempPath)
    expect(plan.userDataPath).not.toBe(DEFAULT_USER_DATA)
    expect(plan.userDataPath).not.toBe(deriveDevelopmentUserDataPath(DEFAULT_USER_DATA))
    expect(plan.shouldOverrideUserData).toBe(true)
  })

  it('3b) test 未注入临时目录时不覆盖（不产生固定 OpenChat-Test）', () => {
    const plan = resolveRuntimeDataPlan({
      isPackaged: false,
      nodeEnv: 'test',
      defaultUserDataPath: DEFAULT_USER_DATA,
    })
    expect(plan.profile).toBe('test')
    expect(plan.temporary).toBe(true)
    expect(plan.shouldOverrideUserData).toBe(false)
  })

  it('development 与 production 推导出的绝对路径必然不同', () => {
    const prod = resolveRuntimeDataPlan({
      isPackaged: true, nodeEnv: 'production', defaultUserDataPath: DEFAULT_USER_DATA,
    })
    const dev = resolveRuntimeDataPlan({
      isPackaged: false, nodeEnv: undefined, defaultUserDataPath: DEFAULT_USER_DATA,
    })
    expect(prod.userDataPath).not.toBe(dev.userDataPath)
  })
})
