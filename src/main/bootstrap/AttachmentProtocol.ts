import { protocol } from 'electron'
import type { AttachmentService } from '../services/attachments/AttachmentService'

export const ATTACHMENT_SCHEME = 'openchat-attachment'

// Renderer 只能提供 attachmentId，主进程通过 DB 反查受管路径。
// 该协议不是任意文件读取接口：id 需通过严格 UUID/hex 格式校验。
const ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/

// 必须在 app ready 之前调用。standard + secure 使其可用于 <img> 且支持 URL 规范化。
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 不开启 bypassCSP：由 CSP 显式允许 img-src openchat-attachment:
        bypassCSP: false,
      },
    },
  ])
}

// app ready 之后调用。URL 形态：
//   openchat-attachment://thumbnail/{attachmentId}
//   openchat-attachment://original/{attachmentId}
export function registerAttachmentProtocol(service: AttachmentService): void {
  protocol.registerFileProtocol(ATTACHMENT_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url)
      const kind = url.hostname
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!ID_PATTERN.test(id)) {
        callback({ error: -6 })
        return
      }
      const resolved = kind === 'original'
        ? service.resolveOriginal(id)
        : kind === 'thumbnail'
          ? service.resolveThumbnail(id)
          : null
      if (!resolved) {
        callback({ error: -6 })
        return
      }
      callback({ path: resolved.filePath, mimeType: resolved.mimeType })
    } catch (err) {
      console.error('[AttachmentProtocol] failed to resolve', request.url, err)
      callback({ error: -6 })
    }
  })
}
