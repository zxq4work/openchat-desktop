import { protocol } from 'electron'

// ── Phase 1：custom scheme 特权注册 ──
// 这是整个 attachment 协议生命周期中「必须最早」的一步：Electron 要求
// registerSchemesAsPrivileged 在 app ready 之前同步完成，否则该 scheme 不会被
// 当作标准/安全 scheme，Renderer 里 <img src="openchat-attachment://..."> 会直接
// 报 net::ERR_UNKNOWN_URL_SCHEME。
//
// 本模块刻意只依赖 electron.protocol，**绝不** import AttachmentService /
// Repository / Storage 等需要 runtime data environment 的业务模块。原因：
// 它必须能被 entry.js 在「configureRuntimeDataEnvironment 之前」静态 import 并同步调用，
// 任何业务依赖提前进入 import graph 都会破坏 userData 覆盖顺序。
export const ATTACHMENT_SCHEME = 'openchat-attachment'

// 必须在 entry 模块同步求值阶段（早于任何 dynamic import / microtask / app.whenReady）调用。
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
  console.log('[AttachmentProtocol] privilegedSchemeRegistered=true')
}
