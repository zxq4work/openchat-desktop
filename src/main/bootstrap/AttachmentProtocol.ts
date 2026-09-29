import { protocol } from 'electron'
import type { AttachmentService } from '../services/attachments/AttachmentService'
import { ATTACHMENT_SCHEME } from './AttachmentScheme'

export { ATTACHMENT_SCHEME }

// Renderer 只能提供 attachmentId，主进程通过 DB 反查受管路径。
// 该协议不是任意文件读取接口：id 需通过严格 UUID/hex 格式校验。
const ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/

// 解析附件服务。handler 安装时 AttachmentService 可能尚未 ready（服务初始化在
// createWindow 之后才完成），因此由 resolver 负责等待就绪，而不是要求安装时已存在。
// 返回 null 表示服务不可用（初始化失败 / 已关闭）→ handler 需回一个安全错误。
export type AttachmentServiceResolver = () => Promise<AttachmentService | null>

// per-request 日志：默认静默，仅在显式开启调试时打印（避免每张缩略图刷屏）。
function attachmentDebugEnabled(): boolean {
  const v = process.env.OPENCHAT_DEBUG_ATTACHMENT
  return v === '1' || v === 'true'
}

// app ready 之后、createWindow() 之前调用。URL 形态：
//   openchat-attachment://thumbnail/{attachmentId}
//   openchat-attachment://original/{attachmentId}
//
// handler 内部 await resolver 等待 AttachmentService 就绪后再 resolve 文件路径，
// 使「协议可接收请求」与「服务已初始化」解耦：BrowserWindow 加载时 handler 已存在，
// 图片真正读取时服务已 ready。
export function registerAttachmentProtocol(resolveService: AttachmentServiceResolver): void {
  protocol.registerFileProtocol(ATTACHMENT_SCHEME, (request, callback) => {
    let settled = false
    // 保证 callback 最多调用一次（解析路径异常 / resolve 失败 / 超时都不重复回调）。
    const respond = (response: Electron.ProtocolResponse): void => {
      if (settled) return
      settled = true
      callback(response)
    }

    void (async () => {
      try {
        const url = new URL(request.url)
        const kind = url.hostname
        const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
        if (attachmentDebugEnabled()) {
          console.log('[AttachmentProtocol] request kind=%s id=%s', kind, id.slice(0, 8))
        }
        if (!ID_PATTERN.test(id)) {
          respond({ error: -6 })
          return
        }

        const service = await resolveService()
        if (!service) {
          console.error('[AttachmentProtocol] resolve failed kind=%s (service unavailable)', kind)
          respond({ error: -6 })
          return
        }

        const resolved = kind === 'original'
          ? service.resolveOriginal(id)
          : kind === 'thumbnail'
            ? service.resolveThumbnail(id)
            : null
        if (!resolved) {
          respond({ error: -6 })
          return
        }
        respond({ path: resolved.filePath, mimeType: resolved.mimeType })
      } catch (err) {
        // 只打印 kind，绝不泄露本地路径 / DB 错误到 Renderer。
        console.error('[AttachmentProtocol] resolve failed:', err)
        respond({ error: -6 })
      }
    })()
  })
  console.log('[AttachmentProtocol] handlerRegistered=true session=default')
}
