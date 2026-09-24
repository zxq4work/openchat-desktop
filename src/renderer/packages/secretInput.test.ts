import { describe, it, expect } from 'vitest'
import {
  resolveInputType,
  INITIAL_EDITING_API_KEY,
  beginLoadingApiKey,
  finishLoadingApiKey,
  failLoadingApiKey,
  editApiKey,
  shouldCommitApiKey,
  type EditingApiKey,
} from './secretInput'

// 测试数据一律使用无意义占位字符串，不使用任何真实凭据格式。
const CREDENTIAL_A = 'credential-value-aaa'
const CREDENTIAL_B = 'credential-value-bbbbbb'

describe('resolveInputType — Eye 只切换原生 type', () => {
  it('1: 默认（不可见）为 password', () => {
    expect(resolveInputType(false)).toBe('password')
  })
  it('2: 可见后为 text', () => {
    expect(resolveInputType(true)).toBe('text')
  })
  it('3: 再次隐藏恢复 password', () => {
    expect(resolveInputType(true)).toBe('text')
    expect(resolveInputType(false)).toBe('password')
  })
})

describe('编辑已有 Provider 的 API Key 加载状态', () => {
  it('4: 编辑打开时进入 loading，不预填任何假值', () => {
    const s = beginLoadingApiKey()
    expect(s.loading).toBe(true)
    expect(s.value).toBe('')
    expect(s.dirty).toBe(false)
  })

  it('7: 读取成功后填入真实 API Key，且 dirty=false', () => {
    const s = finishLoadingApiKey(CREDENTIAL_A)
    expect(s.value).toBe(CREDENTIAL_A)
    expect(s.loading).toBe(false)
    expect(s.dirty).toBe(false)
  })

  it('读取失败回落到空值且 dirty=false（不误报用户修改）', () => {
    const s = failLoadingApiKey()
    expect(s.value).toBe('')
    expect(s.dirty).toBe(false)
    expect(s.loading).toBe(false)
  })
})

describe('apiKeyDirty — 防止未修改时重复保存', () => {
  it('8: 读取后 dirty=false', () => {
    expect(finishLoadingApiKey(CREDENTIAL_A).dirty).toBe(false)
  })

  it('9: 用户修改后 dirty=true', () => {
    const s = editApiKey(CREDENTIAL_B)
    expect(s.dirty).toBe(true)
    expect(s.value).toBe(CREDENTIAL_B)
  })

  it('10: 未修改保存不提交 apiKey', () => {
    expect(shouldCommitApiKey(finishLoadingApiKey(CREDENTIAL_A))).toBe(false)
  })

  it('11: 修改后保存提交（dirty=true）', () => {
    expect(shouldCommitApiKey(editApiKey(CREDENTIAL_B))).toBe(true)
  })

  it('加载失败后保存不提交（避免空值覆盖原 Key）', () => {
    expect(shouldCommitApiKey(failLoadingApiKey())).toBe(false)
  })

  it('新建（初始态）未输入时不提交', () => {
    expect(shouldCommitApiKey(INITIAL_EDITING_API_KEY)).toBe(false)
  })

  it('新建输入后提交', () => {
    expect(shouldCommitApiKey(editApiKey(CREDENTIAL_A))).toBe(true)
  })
})

describe('Eye 切换不修改 value（值保持不变）', () => {
  // visible 由组件内部 state 控制，这里验证其不影响 value：value 完全来自编辑状态。
  it('4/5: 可见性变化不改变 value，onChange 回报真实用户输入', () => {
    let state: EditingApiKey = finishLoadingApiKey(CREDENTIAL_A)
    // 模拟 Eye 切换：只影响 type，不触碰 state
    expect(resolveInputType(false)).toBe('password')
    expect(resolveInputType(true)).toBe('text')
    expect(state.value).toBe(CREDENTIAL_A)
    // 模拟 onChange：返回真实用户输入
    state = editApiKey(CREDENTIAL_B)
    expect(state.value).toBe(CREDENTIAL_B)
    expect(state.value).not.toBe(CREDENTIAL_A)
  })
})

describe('Provider 切换 / 关闭 dialog 的状态语义', () => {
  it('12: 切换 Provider 时重新从 loading 开始，不复用上一个 Provider 的值', () => {
    const providerA = finishLoadingApiKey(CREDENTIAL_A)
    expect(providerA.value).toBe(CREDENTIAL_A)
    // 切到 Provider B：重新进入 loading，value 被清空
    const providerB = beginLoadingApiKey()
    expect(providerB.value).toBe('')
    expect(providerB.value).not.toBe(providerA.value)
  })

  it('13: 关闭 dialog 等价回落到初始态（value 清空、dirty=false）', () => {
    expect(INITIAL_EDITING_API_KEY).toEqual({ value: '', dirty: false, loading: false })
  })
})
