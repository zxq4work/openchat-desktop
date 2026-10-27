import type { IncomingMessage } from 'http'
import * as fs from 'fs'
import type {
  ModelAdapter,
  CanonicalModelRequest,
  CanonicalModelEvent,
  ProviderProtocol,
} from '../../../shared/types/provider'
import { createRequest } from '../../openai/chatgpt/httpsClient'
import { installStreamAbortBridge, makeAbortError, type AbortableStreamState } from '../../openai/chatgpt/transport/abortableStream'
import { UnsupportedImageInputError } from '../errors'
import { logFinalRequestDebug } from '../requestDebug'
import {
  ANTHROPIC_DEFAULT_VERSION,
  resolveAnthropicMessagesUrl,
} from '../../../shared/providers/anthropicEndpoint'
import {
  buildAnthropicRequestBody,
  AnthropicImageError,
  type AnthropicImageEncoder,
  type AnthropicMessagesBody,
} from './AnthropicRequestBuilder'
import { AnthropicSSEDecoder } from './AnthropicSSEDecoder'
import { AnthropicStreamParser } from './AnthropicStreamParser'
import { normalizeAnthropicResponse } from './AnthropicResponseNormalizer'
import { AnthropicApiError, mapAnthropicHttpError } from './AnthropicErrorMapper'

export interface AnthropicAdapterConfig {
  baseUrl: string
  apiKey: string
  toolCalling: boolean
  imageInput?: boolean
  apiVersion?: string
  authMode?: 'x-api-key' | 'bearer'
  endpoint?: string
  anthropicMessagesPath?: string
  maxOutputTokens?: number
  thinking?: { mode: 'off' | 'adaptive' | 'budget'; budgetTokens?: number }
  promptCaching?: boolean
  extraHeaders?: Record<string, string>
  attachmentResolver?: CanonicalModelRequest['attachmentResolver']
}

// Anthropic Messages API 适配器。仅做 canonical ↔ Anthropic 协议映射；
// 能力判断（图片 / thinking / tools）由 Provider 配置与 Service 层决定。
export class AnthropicMessagesAdapter implements ModelAdapter {
  readonly protocol: ProviderProtocol = 'anthropic_messages'
  readonly capabilities: { toolCalling: boolean; reasoning: boolean; supportsImageInput: boolean }

  private baseUrl: string
  private apiKey: string
  private apiVersion: string
  private authMode: 'x-api-key' | 'bearer'
  private endpoint?: string
  private anthropicMessagesPath?: string
  private extraHeaders: Record<string, string>
  private maxOutputTokens?: number
  private thinking?: AnthropicAdapterConfig['thinking']
  private promptCaching?: boolean

  constructor(config: AnthropicAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.apiVersion = config.apiVersion?.trim() || ANTHROPIC_DEFAULT_VERSION
    this.authMode = config.authMode ?? 'x-api-key'
    this.endpoint = config.endpoint?.trim() || undefined
    this.anthropicMessagesPath = config.anthropicMessagesPath
    this.extraHeaders = config.extraHeaders || {}
    this.maxOutputTokens = config.maxOutputTokens
    this.thinking = config.thinking
    this.promptCaching = config.promptCaching
    this.capabilities = {
      toolCalling: config.toolCalling,
      // Anthropic 支持 reasoning effort（output_config.effort），与思考模式独立。
      // reasoning=true 使聊天窗口复用通用 ReasoningSelector，并避免 effort 被清空；
      // thinking=off 不影响该能力（effort 仍可发送，思考内容块按模型实际返回展示）。
      reasoning: true,
      supportsImageInput: config.imageInput ?? false,
    }
  }

  // 解析最终请求 URL（Endpoint 覆盖 > 显式路径 > baseUrl 推导）。
  resolveUrl(): string | null {
    if (this.endpoint) {
      return resolveAnthropicMessagesUrl(this.baseUrl, this.endpoint)
    }
    if (this.anthropicMessagesPath) {
      const base = this.baseUrl
      const p = this.anthropicMessagesPath.trim()
      try {
        return new URL(`${base}${p.startsWith('/') ? p : `/${p}`}`).toString()
      } catch {
        return null
      }
    }
    return resolveAnthropicMessagesUrl(this.baseUrl)
  }

  async *stream(
    request: CanonicalModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalModelEvent> {
    const url = this.resolveUrl()
    if (!url) {
      yield { type: 'error', code: 'ANTHROPIC_INVALID_URL', message: '无效的 Anthropic API 地址' }
      return
    }

    const imageEncoder: AnthropicImageEncoder = {
      encode: (attachmentId: string) => {
        if (!this.capabilities.supportsImageInput) {
          throw new UnsupportedImageInputError()
        }
        const resolved = request.attachmentResolver?.resolveForProvider(attachmentId)
        if (!resolved) throw new AnthropicImageError('图片附件无法解析')
        try {
          const buffer = fs.readFileSync(resolved.storagePath)
          return { mediaType: resolved.mimeType, data: buffer.toString('base64') }
        } catch {
          // 不打印本地路径
          throw new AnthropicImageError('图片文件读取失败')
        }
      },
    }

    let body: AnthropicMessagesBody
    try {
      body = buildAnthropicRequestBody(
        request,
        imageEncoder,
        {
          apiVersion: this.apiVersion,
          authMode: this.authMode,
          maxOutputTokens: this.maxOutputTokens,
          thinking: this.thinking,
          promptCaching: this.promptCaching,
        }
      )
    } catch (err) {
      // 请求构建失败（thinking 预算非法 / 图片无法编码）→ 显式错误事件
      if (err instanceof UnsupportedImageInputError || err instanceof AnthropicImageError) {
        const code = err instanceof UnsupportedImageInputError ? 'UNSUPPORTED_IMAGE_INPUT' : 'ANTHROPIC_IMAGE_UNSUPPORTED'
        yield { type: 'error', code, message: err.message }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', code: 'ANTHROPIC_REQUEST_INVALID', message }
      return
    }

    logFinalRequestDebug('anthropic_messages', body as unknown as Record<string, unknown>, request.dynamicParameters, url)

    const parser = new AnthropicStreamParser()
    const decoder = new AnthropicSSEDecoder()

    try {
      for await (const chunk of this.readStream(url, body, signal)) {
        for (const sseEvent of decoder.feed(chunk)) {
          for (const ev of parser.handle(sseEvent)) yield ev
        }
      }
      // EOF：收尾解码器残余事件
      for (const sseEvent of decoder.flush()) {
        for (const ev of parser.handle(sseEvent)) yield ev
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        // 中断：保留已产生内容（由上层决定），以 AbortError 收尾（不伪造 turn_completed）
        throw makeAbortError()
      }
      if (err instanceof AnthropicApiError) {
        yield { type: 'error', code: err.code, message: err.message }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', code: 'ANTHROPIC_STREAM_ERROR', message }
      return
    }

    if (parser.hasErrored()) {
      // 流内 error 事件已经作为 error 事件发出，标记失败结束，绝不当作正常完成。
      return
    }

    // 未收到 message_stop（异常断开）→ 不无条件判定成功。
    const result = parser.getResult()
    if (!result.completed) {
      if (signal?.aborted) throw makeAbortError()
      yield { type: 'error', code: 'ANTHROPIC_STREAM_INCOMPLETE', message: '响应流意外中断（未收到 message_stop）' }
      return
    }

    // 正常完成：标记 turn_completed
    yield { type: 'turn_completed', turnId: result.messageId }
  }

  // 非流式请求：返回一次聚合后的 canonical 事件（供需要一次性结果的场景）。
  async complete(request: CanonicalModelRequest, signal?: AbortSignal): Promise<CanonicalModelEvent[]> {
    const url = this.resolveUrl()
    if (!url) throw new Error('无效的 Anthropic API 地址')
    const imageEncoder: AnthropicImageEncoder = {
      encode: (attachmentId) => {
        const resolved = request.attachmentResolver?.resolveForProvider(attachmentId)
        if (!resolved) throw new AnthropicImageError('图片附件无法解析')
        const buffer = fs.readFileSync(resolved.storagePath)
        return { mediaType: resolved.mimeType, data: buffer.toString('base64') }
      },
    }
    const body = buildAnthropicRequestBody(request, imageEncoder, {
      apiVersion: this.apiVersion,
      maxOutputTokens: this.maxOutputTokens,
      thinking: this.thinking,
      promptCaching: this.promptCaching,
    })
    body.stream = false
    const json = await this.postJson(url, body, signal)
    return normalizeAnthropicResponse(json)
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'anthropic-version': this.apiVersion,
    }
    if (this.authMode === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else {
      headers['x-api-key'] = this.apiKey
    }
    return { ...headers, ...this.extraHeaders }
  }

  // 流式读取（复用项目统一的取消唤醒桥，兼容 Electron net 与 Node）。
  private async *readStream(
    url: string,
    body: AnthropicMessagesBody,
    signal?: AbortSignal
  ): AsyncIterable<Uint8Array> {
    const parsed = new URL(url)
    const bodyStr = JSON.stringify(body)
    const bodyBytes = Buffer.byteLength(bodyStr)
    const headers = { ...this.buildHeaders(), 'Content-Length': String(bodyBytes) }

    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const isHttps = parsed.protocol === 'https:'
      const defaultPort = isHttps ? 443 : 80
      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : defaultPort,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          protocol: isHttps ? 'https:' : 'http:',
          bypassLocal: true,
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) {
            resolve(res)
            return
          }
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const errText = Buffer.concat(chunks).toString('utf-8')
            const mapped = mapAnthropicHttpError(status, errText, res.headers as Record<string, string | string[] | undefined>)
            reject(new AnthropicApiError(mapped))
          })
          res.on('error', (err: Error) => reject(err))
        }
      )

      let abortHandler: (() => void) | null = null
      if (signal) {
        abortHandler = () => {
          req.destroy()
          reject(makeAbortError())
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }
      req.on('error', (err) => {
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
        reject(err)
      })
      req.write(bodyStr)
      req.end()
    })

    const chunks: Buffer[] = []
    let streamEnded = false
    let streamError: Error | null = null
    let notify: (() => void) | null = null
    let abortBridge: AbortableStreamState | null = null

    const wake = () => {
      if (notify) { const n = notify; notify = null; n() }
    }

    stream.on('data', (chunk: Buffer) => { chunks.push(chunk); wake() })
    stream.on('end', () => { streamEnded = true; abortBridge?.markEnded(); wake() })
    stream.on('error', (err) => { streamError = err; streamEnded = true; abortBridge?.markEnded(); wake() })

    const bridge = installStreamAbortBridge(stream, signal, wake)
    abortBridge = bridge

    let chunkIdx = 0
    try {
      while (true) {
        while (chunkIdx >= chunks.length && !streamEnded && !bridge.isAborted() && !bridge.abortReason()) {
          await new Promise<void>((resolve) => { notify = resolve })
        }
        if (bridge.isAborted()) throw makeAbortError()
        const closeErr = bridge.abortReason()
        if (closeErr) throw closeErr
        if (chunkIdx >= chunks.length && streamEnded) {
          if (streamError) throw streamError
          return
        }
        yield new Uint8Array(chunks[chunkIdx++])
      }
    } finally {
      bridge.cleanup()
    }
  }

  private postJson(url: string, body: AnthropicMessagesBody, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const bodyStr = JSON.stringify(body)
      const bodyBytes = Buffer.byteLength(bodyStr)
      const headers = {
        ...this.buildHeaders(),
        'Accept': 'application/json',
        'Content-Length': String(bodyBytes),
      }
      const isHttps = parsed.protocol === 'https:'
      const req = createRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          protocol: isHttps ? 'https:' : 'http:',
          bypassLocal: true,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8')
            const status = res.statusCode ?? 0
            if (status >= 200 && status < 300) {
              try {
                resolve(JSON.parse(text))
              } catch {
                reject(new Error('Invalid JSON from Anthropic'))
              }
            } else {
              const mapped = mapAnthropicHttpError(status, text, res.headers as Record<string, string | string[] | undefined>)
              reject(new AnthropicApiError(mapped))
            }
          })
          res.on('error', (err: Error) => reject(err))
        }
      )
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(makeAbortError())
        }, { once: true })
      }
      req.on('error', reject)
      req.write(bodyStr)
      req.end()
    })
  }
}