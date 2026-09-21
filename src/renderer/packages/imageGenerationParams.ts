import type { ImageGenerationParameterConfig, ImageGenerationParameterProfile } from '../../shared/types/provider'

// 把 Profile 的单参数配置映射为下拉选项。
// 统一约定：第一项永远是「默认」（value='' → canonical undefined → 请求中省略该字段）。
// Provider 若真实支持字符串 "auto"，应由 Profile 显式提供一个 value='auto' 的 option，
// 不能把 UI 的「默认」与 Provider 的 "auto" 混为一谈。
export interface ParamOption {
  value: string
  label: string
}

export const PARAM_DEFAULT_VALUE = ''

export function buildParamOptions(config: ImageGenerationParameterConfig | undefined): ParamOption[] {
  if (!config || !config.enabled) return []
  const options: ParamOption[] = [{ value: PARAM_DEFAULT_VALUE, label: '默认' }]
  for (const opt of config.options ?? []) {
    options.push({ value: opt.value, label: opt.label })
  }
  return options
}

// 某个已保存值在当前 Profile 下是否仍然合法（用于 UI 回退到「默认」显示 + 下拉补项）。
// 语义与主进程 validateParameterValue 对齐：命中枚举，或在允许自定义值时视为合法。
// 已保存的自定义值在写入前已通过格式校验，此处只需判断 Profile 是否仍允许自定义。
export function isValueAllowed(config: ImageGenerationParameterConfig | undefined, value: string | null): boolean {
  if (!value) return true
  if (!config || !config.enabled) return false
  if (config.options && config.options.length > 0 && config.options.some((o) => o.value === value)) {
    return true
  }
  return config.allowCustom === true
}

// 当前 Profile 是否允许参考图生成（决定 ImageComposer 是否显示「添加参考图」入口）。
// 只读 Profile，绝不根据供应商名称 / 模型名判断。
export function profileSupportsImageToImage(profile: ImageGenerationParameterProfile | undefined): boolean {
  return profile?.operations?.imageToImage.enabled === true
}

// 依据 Profile 得到允许的最大参考图数量（UI 侧限制；Service 为权威层再校验一次）。
export function maxInputImagesForProfile(profile: ImageGenerationParameterProfile | undefined): number {
  const op = profile?.operations
  if (!op || !op.imageToImage.enabled) return 0
  if (!op.imageToImage.multiple) return 1
  return op.imageToImage.maxImages ?? 4
}
