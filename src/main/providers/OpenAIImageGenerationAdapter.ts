import type { IncomingMessage } from 'http'
import { createRequest } from '../openai/chatgpt/httpsClient'
import type {
  ImageGenerationAdapter,
  ImageGenerationRequest,
  ImageGenerationResult,
  GeneratedImage,
  ImageGenerationInputImageMapping,
  ImageGenerationInputImage,
  ImageGenerationWireConfig,
} from '../../shared/types/provider'
import { detectImageMime } from '../services/attachments/imageFormat'
import { ImageGenerationError } from './imageGenerationErrors'
import { validateImageGenerationPayloadPath } from '../../shared/image-generation/parameterProfile'

// 参考图解析结果：编码后的传输字符串 + 用于诊断日志的 MIME / 字节大小。
// 绝不把传输字符串（含 Base64）写入日志。
interface ResolvedInputImage {
  value: string
  mimeType: string
  byteSize: number
}

interface OpenAIImageRequestBody {
  model: string
  prompt: string
  n: number
  size?: string
  quality?: string
  background?: string
  output_format?: string
  // Provider 扩展字段（参考图 / response_format 等），位置由 requestMapping 决定。
  extra_body?: Record<string, unknown>
  // 其余可写字段（顶层参考图、顶层 response_format）由 requestMapping 动态写入。
  [key: string]: unknown
}

interface OpenAIImageDataItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

// Provider 标准错误结构（OpenAI 及多数兼容实现）。
export interface ProviderImageError {
  message?: string
  type?: string
  param?: string
  code?: string
  requestId?: string
}

// 安全解析 Provider 错误体：只提取标准 error 结构，不做任何渲染。
// 用于内部诊断日志，绝不整段 dump 到 UI。
export function parseProviderImageError(body: string): ProviderImageError | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    const err = parsed?.error
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      return {
        message: typeof e.message === 'string' ? e.message : undefined,
        type: typeof e.type === 'string' ? e.type : undefined,
        param: typeof e.param === 'string' ? e.param : undefined,
        code: typeof e.code === 'string' ? e.code : undefined,
      }
    }
    return null
  } catch {
    return null
  }
}

// 日志截断上限：避免异常 Provider 返回超大 HTML/body 导致日志爆炸。
export const MAX_ERROR_BODY_LOG = 8192
export function truncateForLog(body: string, max = MAX_ERROR_BODY_LOG): string {
  if (body.length <= max) return body
  return `${body.slice(0, max)}…[truncated ${body.length - max} chars]`
}

// 供 UI 展示的 Provider 错误摘要：只取标准 error.message 单字段（非整段 JSON），
// 去换行并限长，避免把巨大/多行 body 直接塞进界面。无法提取时返回 null。
export const MAX_USER_ERROR_DETAIL = 300
export function buildUserFacingProviderError(status: number, body: string): string {
  const base = `图片服务返回 HTTP ${status}`
  const parsed = parseProviderImageError(body)
  const detail = parsed?.message?.replace(/\s+/g, ' ').trim()
  if (!detail) return base
  const clipped = detail.length > MAX_USER_ERROR_DETAIL
    ? `${detail.slice(0, MAX_USER_ERROR_DETAIL)}…`
    : detail
  return `${base}：${clipped}`
}

// 路径拼接规则（与 ChatCompletionsAdapter 一致）：自定义路径优先；
// 否则 baseUrl 已含 /v1 时用 /images/generations，避免出现 /v1/v1/...。
export function resolveImageGenerationsPath(baseUrl: string, customPath?: string | null): string {
  if (customPath) return customPath
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? '/images/generations' : '/v1/images/generations'
}

// Canonical 请求 → images/generations JSON body。省略未提供的可选参数。
// encodedInputImages 为已编码的参考图传输值（Data URI），按 wire.requestMapping 写入 body。
// 三件事严格分开：
//   outputFormat            → 顶层 output_format（图片编码格式 png/jpeg/webp）
//   responseFormatParameter → 映射指定的位置（返回传输形式，如 b64_json）
//   inputImages 映射        → 映射指定的位置（参考图数组/单值）
export function buildImageRequestBody(
  request: ImageGenerationRequest,
  encodedInputImages: string[] = []
): OpenAIImageRequestBody {
  const body: OpenAIImageRequestBody = {
    model: request.model,
    prompt: request.prompt,
    // 第一版固定 n = 1
    n: request.n ?? 1,
  }
  if (request.size) body.size = request.size
  if (request.quality) body.quality = request.quality
  if (request.background) body.background = request.background
  // output_format 是否上送由 Profile + Service 决定：字段存在才映射（缺失即 Provider 默认）。
  if (request.outputFormat) body.output_format = request.outputFormat

  const mapping = request.wire?.requestMapping
  // 参考图：位置 / 基数由 requestMapping.inputImages 决定。绝不根据 Provider 名称判断。
  if (encodedInputImages.length > 0 && mapping?.inputImages) {
    writeProviderPayloadField(body, mapping.inputImages.path, shapeInputImages(mapping.inputImages, encodedInputImages))
  }
  // response_format：协议请求参数，与 outputFormat 语义完全不同。
  const resp = mapping?.responseFormatParameter
  if (resp?.enabled && resp.path) {
    writeProviderPayloadField(body, resp.path, resp.value)
  }

  return body
}

// 按 cardinality 决定参考图写入形式：single → 首个值；array → 完整数组。
function shapeInputImages(mapping: ImageGenerationInputImageMapping, values: string[]): unknown {
  return mapping.cardinality === 'single' ? values[0] : values
}

// 按 requestMapping 路径把值写入 body。
// 只允许 '<顶层字段>' 或 'extra_body.<字段>'；路径非法时抛错（绝不写到未知位置）。
export function writeProviderPayloadField(body: OpenAIImageRequestBody, path: string, value: unknown): void {
  const err = validateImageGenerationPayloadPath(path)
  if (err) {
    throw new ImageGenerationError('IMAGE_GENERATION_INPUT_IMAGE_INVALID', `协议字段路径无效：${err}`)
  }
  const segments = path.split('.')
  if (segments.length === 2) {
    body.extra_body = { ...(body.extra_body ?? {}), [segments[1]]: value }
    return
  }
  body[segments[0]] = value
}

// 参考图编码：本地受管图片统一编码为 Data URI。
// 本项目不将本地图片上传公网，故不存在「公网 URL」编码（encoding 收敛为 data_url）。
export function encodeInputImageValue(bytes: Uint8Array, mimeType: string): string {
  const base64 = Buffer.from(bytes).toString('base64')
  return `data:${mimeType};base64,${base64}`
}

// 把 Canonical inputImages（只含 attachmentId）解析为编码后的传输值。
// - 无 inputImages → text_to_image
// - 未配置 requestMapping.inputImages / 缺 resolver → 配置错误
// - 任一参考图读取失败 → 抛错（绝不静默丢弃参考图退化为文生图）
// 顺序与 inputImages 一致。
export function resolveInputImages(
  inputImages: ImageGenerationInputImage[] | undefined,
  mapping: ImageGenerationInputImageMapping | undefined,
  resolver: { resolveForGeneration(id: string): { bytes: Uint8Array; mimeType: string } | null } | undefined
): { encoded: string[]; resolved: ResolvedInputImage[]; operation: 'text_to_image' | 'image_to_image' } {
  const list = inputImages ?? []
  if (list.length === 0) {
    return { encoded: [], resolved: [], operation: 'text_to_image' }
  }
  if (!mapping) {
    throw new ImageGenerationError(
      'IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED',
      '当前图片供应商未配置参考图传输方式'
    )
  }
  if (!resolver) {
    throw new ImageGenerationError('IMAGE_GENERATION_INPUT_IMAGE_READ_FAILED', '参考图读取器不可用')
  }

  const encoded: string[] = []
  const resolved: ResolvedInputImage[] = []
  for (const img of list) {
    const read = resolver.resolveForGeneration(img.attachmentId)
    if (!read) {
      throw new ImageGenerationError('IMAGE_GENERATION_INPUT_IMAGE_NOT_FOUND', '参考图不存在或已被删除')
    }
    const value = encodeInputImageValue(read.bytes, read.mimeType)
    encoded.push(value)
    resolved.push({ value, mimeType: read.mimeType, byteSize: read.bytes.length })
  }
  return { encoded, resolved, operation: 'image_to_image' }
}

// 生成请求体的 sanitize 版本：替换参考图值为摘要，避免把 Base64 写入日志。
export function sanitizeImageBodyForLog(
  body: OpenAIImageRequestBody,
  resolved: ResolvedInputImage[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(body)) {
    if (key === 'prompt') {
      out.prompt = `<${(val ?? '').toString().length} chars>`
      continue
    }
    if (key === 'extra_body' && val && typeof val === 'object') {
      const eb: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        eb[k] = shapeDataPlaceholder(v, resolved)
      }
      out.extra_body = eb
      continue
    }
    out[key] = shapeDataPlaceholder(val, resolved)
  }
  return out
}

// 参考图数组（Data URI 字符串，与已解析参考图数量一致）→ 替换为 MIME/字节摘要；
// 单值 Data URI（cardinality=single）→ 同样替换为首张摘要。其余值原样返回。
// 目的：无论映射到哪个字段，都绝不把 Base64 / Data URI 写入日志。
function shapeDataPlaceholder(value: unknown, resolved: ResolvedInputImage[]): unknown {
  if (resolved.length === 0) return value
  const summary = resolved.map((r, i) => `<image ${i + 1}: ${r.mimeType}, ${r.byteSize} bytes>`)
  if (typeof value === 'string' && value.startsWith('data:')) return summary[0]
  if (Array.isArray(value) && value.length === resolved.length &&
    value.every((v) => typeof v === 'string' && v.startsWith('data:'))) {
    return summary
  }
  return value
}

// 解析响应 JSON，抽取 data[] 数组。兼容 { data: [...] } 与顶层数组两种形态。
// 无有效图片数据时抛 IMAGE_GENERATION_INVALID_RESPONSE。
export function parseImageResponseItems(resBody: string): OpenAIImageDataItem[] {
  let parsed: { data?: OpenAIImageDataItem[] } | OpenAIImageDataItem[]
  try {
    parsed = JSON.parse(resBody) as { data?: OpenAIImageDataItem[] } | OpenAIImageDataItem[]
  } catch {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', '图片服务返回了无法解析的响应')
  }

  const items: OpenAIImageDataItem[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : []

  if (items.length === 0) {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', '图片服务未返回任何图片')
  }
  return items
}

// POST /v1/images/generations 适配器。
// 与 Chat 协议完全独立：无 SSE、无 messages、无 tools，一次请求返回结果 JSON。
export class OpenAIImageGenerationAdapter implements ImageGenerationAdapter {
  readonly protocol = 'image_generations' as const

  private baseUrl: string
  private apiKey: string
  private imageGenerationsPath: string
  private extraHeaders: Record<string, string>
  private wireConfig: ImageGenerationWireConfig

  constructor(config: {
    baseUrl: string
    apiKey: string
    imageGenerationsPath?: string
    extraHeaders?: Record<string, string>
    wireConfig?: ImageGenerationWireConfig
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.extraHeaders = config.extraHeaders || {}
    this.wireConfig = config.wireConfig ?? {}
    // 复用与 ChatCompletionsAdapter 相同的路径拼接规则，避免 /v1/v1/... 重复
    this.imageGenerationsPath = resolveImageGenerationsPath(this.baseUrl, config.imageGenerationsPath)
  }

  async generate(
    request: ImageGenerationRequest,
    signal?: AbortSignal
  ): Promise<ImageGenerationResult> {
    const url = `${this.baseUrl}${this.imageGenerationsPath}`

    // wire 配置优先取请求显式传入（Service 从 Profile 派生），否则回退构造时的默认。
    const wire: ImageGenerationWireConfig = request.wire ?? this.wireConfig
    const effective: ImageGenerationRequest = { ...request, wire }

    // 参考图：Canonical 请求只携带 attachmentId，真正字节在这一步由 Main 读取并编码。
    // 编码仅存在于本次 HTTP 请求期间，不进入 Canonical 结构 / DB / 日志。
    const { encoded, resolved, operation } = resolveInputImages(
      effective.inputImages,
      wire.requestMapping?.inputImages,
      effective.inputImageResolver
    )
    const body = buildImageRequestBody(effective, encoded)

    // 诊断日志：只打印 endpoint 与各可选参数的存在/取值，绝不打印 Authorization / API Key。
    // prompt 只记录长度；参考图只记录 MIME + 字节大小 + 数量，绝不打印 Base64 / Data URI。
    const respFormatLog = wire.requestMapping?.responseFormatParameter?.enabled
      ? String(wire.requestMapping.responseFormatParameter.value)
      : '-'
    console.log(
      '[ImageGeneration] request endpoint=%s model=%s operation=%s n=%d size=%s quality=%s background=%s outputFormat=%s responseFormat=%s inputImageCount=%d inputMimeTypes=%s inputByteSizes=%s promptLength=%d',
      this.imageGenerationsPath,
      request.model,
      operation,
      body.n,
      request.size ?? '-',
      request.quality ?? '-',
      request.background ?? '-',
      request.outputFormat ?? '-',
      respFormatLog,
      resolved.length,
      resolved.map((r) => r.mimeType).join(',') || '-',
      resolved.map((r) => String(r.byteSize)).join(',') || '-',
      (request.prompt ?? '').length
    )

    // 开发阶段：debug 级打印已 sanitize 的 body（prompt 只留长度、参考图只留摘要），
    // 便于排查参数兼容问题，同时避免把 Base64 图片写进日志。
    if (process.env.OPENCHAT_IMAGE_DEBUG === 'true') {
      console.debug('[ImageGeneration] sanitized body=%s', JSON.stringify(sanitizeImageBodyForLog(body, resolved)))
    }

    const resBody = await this.postJson(url, body, signal)
    const items = parseImageResponseItems(resBody)

    const images: GeneratedImage[] = []
    for (const item of items) {
      if (item.b64_json) {
        const bytes = Buffer.from(item.b64_json, 'base64')
        images.push(this.toGeneratedImage(bytes, item.revised_prompt))
        continue
      }
      if (item.url) {
        const bytes = await this.downloadImage(item.url, signal)
        images.push(this.toGeneratedImage(bytes, item.revised_prompt))
        continue
      }
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', '图片响应缺少图片数据')
    }

    return { images }
  }

  // 校验 magic bytes，避免把 Provider 返回的非图片字节落盘
  private toGeneratedImage(bytes: Buffer, revisedPrompt: string | undefined): GeneratedImage {
    if (bytes.length === 0) {
      throw new ImageGenerationError('IMAGE_GENERATION_INVALID_RESPONSE', '图片数据为空')
    }
    const mimeType = detectImageMime(bytes)
    if (!mimeType) {
      throw new ImageGenerationError('IMAGE_GENERATION_DECODE_FAILED', '图片数据格式不受支持')
    }
    return { bytes, mimeType, revisedPrompt }
  }

  // POST JSON，返回响应体字符串。HTTP 非 2xx 视为生成失败。
  private postJson(
    url: string,
    body: OpenAIImageRequestBody,
    signal?: AbortSignal
  ): Promise<string> {
    const parsed = new URL(url)
    const bodyStr = JSON.stringify(body)

    return new Promise<string>((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }

      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : undefined,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyStr)),
            ...this.extraHeaders,
          },
          protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
          bypassLocal: true,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => { data += chunk.toString() })
          res.on('end', () => {
            if (settled) return
            const status = res.statusCode ?? 0
            if (status >= 200 && status < 300) {
              settled = true
              resolve(data)
            } else {
              // 诊断：打印 Provider 错误体（截断上限），并解析标准 error 结构。
              // 这是第三方参数兼容的关键排查依据，必须保留；但不进入 UI。
              const parsedError = parseProviderImageError(data)
              console.error(
                '[ImageGeneration] HTTP status=%d body=%s',
                status,
                truncateForLog(data)
              )
              if (parsedError) {
                console.error(
                  '[ImageGeneration] provider error type=%s code=%s param=%s message=%s',
                  parsedError.type ?? '-',
                  parsedError.code ?? '-',
                  parsedError.param ?? '-',
                  parsedError.message ?? '-'
                )
              }
              fail(new ImageGenerationError(
                'IMAGE_GENERATION_FAILED',
                buildUserFacingProviderError(status, data)
              ))
            }
          })
        }
      )

      let abortHandler: (() => void) | null = null
      if (signal) {
        abortHandler = () => {
          req.destroy()
          fail(new ImageGenerationError('IMAGE_GENERATION_ABORTED', '已停止生成'))
        }
        if (signal.aborted) {
          abortHandler()
          return
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      req.on('error', (err) => {
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
        fail(new ImageGenerationError('IMAGE_GENERATION_FAILED', err.message || '图片生成请求失败'))
      })
      req.write(bodyStr)
      req.end()
    })
  }

  // 兼容返回 url 的 Provider：由 Main 下载字节，Renderer 永远不直接访问 Provider。
  private downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
    const parsed = new URL(url)

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }

      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : undefined,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { Accept: 'image/*' },
          protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
          bypassLocal: true,
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            res.resume()
            fail(new ImageGenerationError('IMAGE_GENERATION_DOWNLOAD_FAILED', `下载图片失败（HTTP ${status}）`))
            return
          }
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            if (settled) return
            settled = true
            resolve(Buffer.concat(chunks))
          })
          res.on('error', () => {
            fail(new ImageGenerationError('IMAGE_GENERATION_DOWNLOAD_FAILED', '下载图片失败'))
          })
        }
      )

      let abortHandler: (() => void) | null = null
      if (signal) {
        abortHandler = () => {
          req.destroy()
          fail(new ImageGenerationError('IMAGE_GENERATION_ABORTED', '已停止生成'))
        }
        if (signal.aborted) {
          abortHandler()
          return
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      req.on('error', (err) => {
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
        fail(new ImageGenerationError('IMAGE_GENERATION_DOWNLOAD_FAILED', err.message || '下载图片失败'))
      })
      req.end()
    })
  }
}
