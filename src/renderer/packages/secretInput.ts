// SecretInput 与 Provider 编辑弹窗凭证状态的纯逻辑。
// 设计原则：不做任何人工 mask。输入框始终持有真实值，隐藏完全交给原生 password input，
// 浏览器按真实字符数渲染圆点 —— 因此「同一份内容」的圆点数量天然一致。

export type SecretInputType = 'password' | 'text'

// Eye 只切换原生 input 的 type，不生成、不计算任何掩码。
export function resolveInputType(visible: boolean): SecretInputType {
  return visible ? 'text' : 'password'
}

// 编辑已有 Provider 时 API Key 的加载/编辑状态。
// dirty 仅在用户改动后为 true，用于避免未修改时无意义地重复写库。
export interface EditingApiKey {
  value: string
  dirty: boolean
  loading: boolean
}

export const INITIAL_EDITING_API_KEY: EditingApiKey = { value: '', dirty: false, loading: false }

// 打开编辑弹窗、开始异步读取真实 Key：不预填任何假值，标记 loading。
export function beginLoadingApiKey(): EditingApiKey {
  return { value: '', dirty: false, loading: true }
}

// 读取成功：填入真实 Key；用户尚未修改，故 dirty=false。
export function finishLoadingApiKey(value: string): EditingApiKey {
  return { value, dirty: false, loading: false }
}

// 读取失败：回落到空值且 dirty=false，保存时不会提交空值覆盖原 Key。
export function failLoadingApiKey(): EditingApiKey {
  return { value: '', dirty: false, loading: false }
}

// 用户编辑：值变化即置 dirty=true。
export function editApiKey(value: string): EditingApiKey {
  return { value, dirty: true, loading: false }
}

// 保存时是否应提交 apiKey 更新：只有用户真正改过才写库，
// 保证「打开 → 未修改 → 保存」不会重复写入，也不会把加载态写成空值。
export function shouldCommitApiKey(state: EditingApiKey): boolean {
  return state.dirty
}
