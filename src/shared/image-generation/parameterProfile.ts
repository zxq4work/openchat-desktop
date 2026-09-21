import type {
  ImageGenerationParameterConfig,
  ImageGenerationParameterProfile,
  ImageGenerationParameterOption,
  ImageGenerationOperationProfile,
  ImageGenerationImageToImageConfig,
  ImageGenerationRequestMapping,
  ImageGenerationInputImageMapping,
  ImageGenerationInputCardinality,
  ImageGenerationResponseFormatMapping,
  ImageGenerationResponseFormatValueType,
} from '../types/provider'

// 图生图参考图数量硬上限：即使 Profile 未显式声明 maxImages，也不允许无限添加。
export const MAX_GENERATION_INPUT_IMAGES = 8
export const DEFAULT_GENERATION_INPUT_MAX_IMAGES = 4

// 当前 Profile schema 版本。v2 起协议细节收敛到 requestMapping。
export const IMAGE_GENERATION_PROFILE_VERSION = 2

// Image Generation 参数 Profile 的纯逻辑：预设、反序列化、校验、reconciliation。
// 不依赖 Node / Electron，供 Main（Service 校验）与 Renderer（UI 渲染）共用，
// 便于在 node 测试环境下单测。
// 核心原则：Profile 决定"某个参数是否存在 / 允许哪些值"，
// Adapter 只负责把已确认合法的 canonical 参数映射成 HTTP JSON。

// 允许自定义值的参数的基础格式校验（目前只有 size 需要）。
// 不要把这些格式含义硬编码为某供应商专属——它们是 WIDTHxHEIGHT 的通用表达。
const CUSTOM_VALUE_PATTERNS: Partial<Record<keyof ImageGenerationParameterProfile, RegExp>> = {
  // 1536x1024 / 1536X1024（同时允许 1K/2K/3K/4K 这类通称，由 predefined option 提供）
  size: /^\d+[xX]\d+$/,
}

// OpenAI 官方 Images API 兼容 Profile（gpt-image-1 参数集）。
// 具体枚举以官方 contract 为准；这里只描述"支持哪些值与枚举"。
export function openAIImageProfile(): ImageGenerationParameterProfile {
  return {
    version: IMAGE_GENERATION_PROFILE_VERSION,
    size: {
      enabled: true,
      options: [
        { label: '1024 × 1024（正方形）', value: '1024x1024' },
        { label: '1536 × 1024（横向）', value: '1536x1024' },
        { label: '1024 × 1536（纵向）', value: '1024x1536' },
      ],
      allowCustom: false,
    },
    quality: {
      enabled: true,
      options: [
        { label: '低', value: 'low' },
        { label: '中', value: 'medium' },
        { label: '高', value: 'high' },
      ],
      allowCustom: false,
    },
    background: {
      enabled: true,
      options: [
        { label: '不透明', value: 'opaque' },
        { label: '透明', value: 'transparent' },
      ],
      allowCustom: false,
    },
    outputFormat: {
      enabled: true,
      options: [
        { label: 'PNG', value: 'png' },
        { label: 'JPEG', value: 'jpeg' },
        { label: 'WebP', value: 'webp' },
      ],
      allowCustom: false,
    },
    // OpenAI 官方 /images/generations 不支持参考图，仅文生图。
    operations: { textToImage: true, imageToImage: { enabled: false, multiple: false } },
  }
}

// 自定义最小 Profile：所有可选参数关闭，只发送 model / prompt / n。
// 这是未知第三方 Provider 与旧数据迁移的安全默认（不假定 OpenAI 兼容）。
export function customMinimalProfile(): ImageGenerationParameterProfile {
  return {
    version: IMAGE_GENERATION_PROFILE_VERSION,
    size: { enabled: false },
    quality: { enabled: false },
    background: { enabled: false },
    outputFormat: { enabled: false },
    // 未知第三方：只假定最保守的文生图，绝不默认开启图生图。
    operations: { textToImage: true, imageToImage: { enabled: false, multiple: false } },
  }
}

// 通用「图生图」预设（image_generations 协议下的一组能力组合，与具体供应商无关）：
// - 文生图 + 参考图生成（图生图），支持多张参考图
// - size 使用 1K/2K/3K/4K 通称
// 只表达能力模板：requestMapping（参考图字段位置 / 响应控制参数）一律留空，
// 由用户在「高级协议兼容设置」中显式配置。核心代码绝不猜测任何供应商特有的 wire mapping。
export function customImageToImageProfile(): ImageGenerationParameterProfile {
  return {
    version: IMAGE_GENERATION_PROFILE_VERSION,
    size: {
      enabled: true,
      options: [
        { label: '1K', value: '1K' },
        { label: '2K', value: '2K' },
        { label: '3K', value: '3K' },
        { label: '4K', value: '4K' },
      ],
      allowCustom: false,
    },
    quality: { enabled: false },
    background: { enabled: false },
    outputFormat: { enabled: false },
    operations: {
      textToImage: true,
      imageToImage: { enabled: true, multiple: true, maxImages: 4 },
    },
  }
}

// ── 协议字段路径（requestMapping）安全校验 ──
// 只允许 '<顶层字段>' 或 'extra_body.<字段>'，字段名必须为标识符。
// 明确拒绝任意嵌套（a.b.c.d）与原型污染字段（__proto__ / constructor / prototype）。
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const PATH_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// 校验协议字段路径。返回 null 表示合法，否则返回面向用户的错误文案。
export function validateImageGenerationPayloadPath(path: string): string | null {
  const trimmed = (path ?? '').trim()
  if (!trimmed) return '协议字段路径不能为空'
  const segments = trimmed.split('.')
  if (segments.length > 2) return '协议字段路径仅支持「顶层字段」或「extra_body.字段」'
  if (segments.some((s) => !PATH_SEGMENT_PATTERN.test(s))) return '协议字段路径含非法字符'
  if (segments.some((s) => FORBIDDEN_PATH_SEGMENTS.has(s))) return '协议字段路径含保留字段'
  if (segments.length === 2 && segments[0] !== 'extra_body') return '二级路径必须以 extra_body 开头'
  return null
}

// 归一化协议字段路径：合法则返回 trim 后的值，否则返回 undefined（丢弃，绝不写入畸形路径）。
function sanitizePayloadPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return validateImageGenerationPayloadPath(trimmed) === null ? trimmed : undefined
}

// 反序列化容错：任何字段缺失 / 类型错误都回退到最小集，绝不抛错。
// 用于旧库（无 profile）与用户手改 JSON 的场景。
// v1（transport / response）→ v2（requestMapping）的迁移在此完成，旧库无需手工修改。
export function normalizeImageGenerationProfile(raw: unknown): ImageGenerationParameterProfile {
  if (!raw || typeof raw !== 'object') return customMinimalProfile()
  const obj = raw as Record<string, unknown>

  const parseConfig = (value: unknown): ImageGenerationParameterConfig => {
    if (!value || typeof value !== 'object') return { enabled: false }
    const c = value as Record<string, unknown>
    const enabled = c.enabled === true
    let options: ImageGenerationParameterOption[] | undefined
    if (Array.isArray(c.options)) {
      const parsed: ImageGenerationParameterOption[] = []
      for (const item of c.options) {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>
          if (typeof o.value === 'string') {
            parsed.push({ label: typeof o.label === 'string' ? o.label : o.value, value: o.value })
          }
        }
      }
      if (parsed.length > 0) options = parsed
    }
    return { enabled, options, allowCustom: c.allowCustom === true }
  }

  const profile: ImageGenerationParameterProfile = {
    version: IMAGE_GENERATION_PROFILE_VERSION,
    size: parseConfig(obj.size),
    quality: parseConfig(obj.quality),
    background: parseConfig(obj.background),
    outputFormat: parseConfig(obj.outputFormat),
  }

  const n = obj.n
  if (n && typeof n === 'object') {
    const nc = n as Record<string, unknown>
    profile.n = {
      enabled: nc.enabled === true,
      min: Number.isFinite(Number(nc.min)) ? Number(nc.min) : 1,
      max: Number.isFinite(Number(nc.max)) ? Number(nc.max) : 1,
      defaultValue: Number.isFinite(Number(nc.defaultValue)) ? Number(nc.defaultValue) : undefined,
    }
  }

  profile.operations = normalizeOperations(obj.operations)

  // 优先级：v2 requestMapping > v1 inputImages/response（迁移）。两者都不存在则不写。
  // 注意：绝不因「图生图开启」而自动补任何参考图字段映射——Custom Provider 的
  // 参考图字段必须由用户显式配置（缺失即配置错误，由 Service 权威层拒绝）。
  const requestMapping = normalizeRequestMapping(obj.requestMapping)
    ?? migrateLegacyRequestMapping(obj.inputImages, obj.response)
  if (requestMapping) profile.requestMapping = requestMapping

  return profile
}

// 操作能力容错：缺失 / 非法 → 仅文生图（最保守）。绝不默认开启图生图。
export function normalizeOperations(raw: unknown): ImageGenerationOperationProfile {
  const fallback: ImageGenerationOperationProfile = {
    textToImage: true,
    imageToImage: { enabled: false, multiple: false },
  }
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>

  // textToImage 缺失时按 true（保持旧 Profile 的文生图能力），显式 false 才关闭。
  const textToImage = obj.textToImage !== false

  const i2i = obj.imageToImage
  const imageToImage: ImageGenerationImageToImageConfig = { enabled: false, multiple: false }
  if (i2i && typeof i2i === 'object') {
    const c = i2i as Record<string, unknown>
    imageToImage.enabled = c.enabled === true
    imageToImage.multiple = c.multiple === true
    if (Number.isFinite(Number(c.maxImages))) {
      imageToImage.maxImages = clampMaxImages(Number(c.maxImages))
    }
  }
  return { textToImage, imageToImage }
}

const VALID_CARDINALITIES: ImageGenerationInputCardinality[] = ['single', 'array']
const VALID_RESPONSE_VALUE_TYPES: ImageGenerationResponseFormatValueType[] = ['string', 'boolean']

// v2 requestMapping 反序列化：任一子项非法即丢弃该子项（绝不写入畸形映射）。
export function normalizeRequestMapping(raw: unknown): ImageGenerationRequestMapping | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const out: ImageGenerationRequestMapping = {}

  const inputRaw = obj.inputImages
  if (inputRaw && typeof inputRaw === 'object') {
    const c = inputRaw as Record<string, unknown>
    const path = sanitizePayloadPath(c.path)
    if (path) {
      out.inputImages = {
        path,
        cardinality: VALID_CARDINALITIES.includes(c.cardinality as ImageGenerationInputCardinality)
          ? (c.cardinality as ImageGenerationInputCardinality)
          : 'array',
        // 本地受管图片只能以 Data URI 传输；encoding 收敛为单一取值。
        encoding: 'data_url',
      }
    }
  }

  const respRaw = obj.responseFormatParameter
  if (respRaw && typeof respRaw === 'object') {
    const c = respRaw as Record<string, unknown>
    const enabled = c.enabled === true
    const path = sanitizePayloadPath(c.path)
    const valueType = VALID_RESPONSE_VALUE_TYPES.includes(c.valueType as ImageGenerationResponseFormatValueType)
      ? (c.valueType as ImageGenerationResponseFormatValueType)
      : 'string'
    // enabled 但缺合法路径 → 丢弃整个映射（不能发送到未知位置）。
    if (!enabled || path) {
      out.responseFormatParameter = {
        enabled,
        path: path ?? '',
        valueType,
        value: valueType === 'boolean' ? c.value === true : (typeof c.value === 'string' ? c.value : ''),
      }
    }
  }

  return out.inputImages || out.responseFormatParameter ? out : undefined
}

// v1 → v2 迁移（旧库升级路径）：
// - inputImages.transport：extra_body_image → extra_body.image / top_level_image → image / custom → payloadPath
// - response.transport + format：extra_body + b64_json → extra_body.response_format；top_level → response_format；未配置 → enabled:false
export function migrateLegacyRequestMapping(
  legacyInput: unknown,
  legacyResponse: unknown
): ImageGenerationRequestMapping | undefined {
  const out: ImageGenerationRequestMapping = {}

  if (legacyInput && typeof legacyInput === 'object') {
    const c = legacyInput as Record<string, unknown>
    // v1: enabled=false 视为无参考图映射
    if (c.enabled === true) {
      const transport = c.transport
      let path: string | undefined
      if (transport === 'top_level_image') path = 'image'
      else if (transport === 'custom') path = sanitizePayloadPath(c.payloadPath)
      else path = 'extra_body.image'
      if (path) {
        // v1 的 multiple/maxImages 记录的是「能否多张」；单张 → single，否则 array。
        out.inputImages = {
          path,
          cardinality: c.multiple === true ? 'array' : 'single',
          encoding: 'data_url',
        }
      }
    }
  }

  if (legacyResponse && typeof legacyResponse === 'object') {
    const c = legacyResponse as Record<string, unknown>
    const format = c.format === 'url' || c.format === 'b64_json' ? c.format : undefined
    if (format) {
      out.responseFormatParameter = {
        enabled: true,
        path: c.transport === 'top_level' ? 'response_format' : 'extra_body.response_format',
        valueType: 'string',
        value: format,
      }
    } else {
      // v1 未固定返回形式 = 不发送该字段
      out.responseFormatParameter = { enabled: false, path: '', valueType: 'string', value: '' }
    }
  }

  return out.inputImages || out.responseFormatParameter ? out : undefined
}

// 参考图数量上限收敛到 [1, MAX_GENERATION_INPUT_IMAGES]，避免畸形配置。
export function clampMaxImages(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GENERATION_INPUT_MAX_IMAGES
  return Math.max(1, Math.min(MAX_GENERATION_INPUT_IMAGES, Math.round(value)))
}

// 依据 Profile 得到本次允许的最大参考图数量。未启用图生图 → 0。
export function resolveMaxInputImages(profile: ImageGenerationParameterProfile): number {
  const op = profile.operations
  if (!op || !op.imageToImage.enabled) return 0
  if (!op.imageToImage.multiple) return 1
  const declared = op.imageToImage.maxImages
  return declared !== undefined ? clampMaxImages(declared) : DEFAULT_GENERATION_INPUT_MAX_IMAGES
}

// 校验参考图数量（Service 权威层，不信任 UI）。
// 返回 null 表示合法，否则返回面向用户的错误文案。
export function validateInputImageCount(
  profile: ImageGenerationParameterProfile,
  count: number
): string | null {
  if (count <= 0) return null
  const op = profile.operations
  if (!op || !op.imageToImage.enabled) {
    return '当前图片供应商不支持参考图生成，请删除参考图或更换服务。'
  }
  if (!op.imageToImage.multiple && count > 1) {
    return '当前图片供应商不支持多张参考图，请只保留一张。'
  }
  const max = resolveMaxInputImages(profile)
  if (count > max) {
    return `参考图数量超过上限（最多 ${max} 张）。`
  }
  return null
}

// 单个参数值的合法性判定。
// 返回 null 表示合法（或该参数未携带值）。
export function validateParameterValue(
  field: keyof ImageGenerationParameterProfile,
  config: ImageGenerationParameterConfig,
  value: string
): string | null {
  if (!config.enabled) {
    return `当前图片供应商不支持参数「${paramLabel(field)}」`
  }
  if (config.options && config.options.length > 0) {
    if (config.options.some((o) => o.value === value)) return null
    // 不在枚举内：仅当允许自定义且格式通过时才放行
    if (config.allowCustom && matchesCustomFormat(field, value)) return null
    return `参数「${paramLabel(field)}」的值「${value}」不在允许范围内`
  }
  // 无 predefined 枚举：仅依赖 allowCustom
  if (config.allowCustom) {
    return matchesCustomFormat(field, value) ? null : `参数「${paramLabel(field)}」的值「${value}」格式无效`
  }
  return `参数「${paramLabel(field)}」不接受自定义值`
}

function matchesCustomFormat(field: keyof ImageGenerationParameterProfile, value: string): boolean {
  const pattern = CUSTOM_VALUE_PATTERNS[field]
  return pattern ? pattern.test(value) : true
}

export interface ImageGenerationRequestedParams {
  size?: string | null
  quality?: string | null
  background?: string | null
  outputFormat?: string | null
}

const PARAM_FIELDS: Array<keyof ImageGenerationRequestedParams> = ['size', 'quality', 'background', 'outputFormat']

// 参数中文名，用于校验错误文案（避免向用户暴露 outputFormat 这类内部字段名）。
const PARAM_LABELS: Record<keyof ImageGenerationRequestedParams, string> = {
  size: '尺寸',
  quality: '质量',
  background: '背景',
  outputFormat: '输出格式',
}

// 接受比 ImageGenerationRequestedParams 更宽的 key（调用方可能传 keyof ImageGenerationParameterProfile，含 n），
// 未登记中文名的字段回退为原始 key。
export function paramLabel(field: string): string {
  return PARAM_LABELS[field as keyof ImageGenerationRequestedParams] ?? field
}

// 严格校验"本次请求实际要发送的参数"（Service 权威层，防止绕过 UI 发送非法值）。
// - 未携带值 → 保留 undefined（Provider 默认，不上送字段）
// - 携带值但 Profile 未启用 → 视为非法（调用方不应发送未启用参数）
// - 携带值且启用 → 校验合法性，非法报错
// 返回 cleaned（可上送的 canonical 值）与 error（首个非法原因）。
export function validateRequestedParams(
  profile: ImageGenerationParameterProfile,
  requested: ImageGenerationRequestedParams
): { cleaned: ImageGenerationRequestedParams; error: string | null } {
  const cleaned: ImageGenerationRequestedParams = {}
  for (const field of PARAM_FIELDS) {
    const value = requested[field]
    if (value === undefined || value === null || value === '') continue
    const config = profile[field]
    if (!config.enabled) return { cleaned, error: `当前图片供应商不支持参数「${paramLabel(field)}」` }
    const err = validateParameterValue(field, config, value)
    if (err) return { cleaned, error: err }
    cleaned[field] = value
  }
  return { cleaned, error: null }
}

// Provider 切换 / Profile 变更时的参数 reconciliation：
// 逐个参数，若当前值在新 Profile 中仍合法则保留，否则重置为 undefined（Provider 默认）。
// 不会用新 Profile 的第一个 option 强行替换。
export function reconcileImageDefaults(
  profile: ImageGenerationParameterProfile,
  current: { size: string | null; quality: string | null; background: string | null }
): { size: string | null; quality: string | null; background: string | null } {
  const keep = (field: 'size' | 'quality' | 'background', value: string | null): string | null => {
    if (!value) return null
    const config = profile[field]
    if (!config.enabled) return null
    return validateParameterValue(field, config, value) === null ? value : null
  }
  return {
    size: keep('size', current.size),
    quality: keep('quality', current.quality),
    background: keep('background', current.background),
  }
}
