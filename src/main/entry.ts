// 最小 Electron 主进程入口。
//
// 这是 main process 真正的启动边界，顺序由三件事共同约束：
//   1. custom scheme 特权注册（registerSchemesAsPrivileged）必须同步且最早 ——
//      Electron 要求在 app ready 之前完成，否则 scheme 不生效（ERR_UNKNOWN_URL_SCHEME）。
//      因此放在模块主体第一行同步执行，早于任何 dynamic import / microtask。
//   2. 确定 userData 目录（production 不改 / development → openchat-desktop-dev / test → 临时目录）。
//   3. 再动态 import bootstrap/main，使其及其全部业务依赖在 userData 配置完成之后才加载。
//
// 为什么必须动态 import：ESM / CJS 的静态 import 会在当前模块主体执行前先加载依赖链。
// 若这里直接静态 `import './bootstrap/main'`，bootstrap 依赖链中任何
// `app.getPath('userData')`（即便是模块顶层缓存）都会在 userData 覆盖前拿到 production 路径。
// 动态 import 保证顺序：configureRuntimeDataEnvironment() 先于 bootstrap 加载。
//
// 注意：下面两个静态 import 均不触碰业务依赖图。AttachmentScheme.ts 只依赖
// electron.protocol（不含 AttachmentService/Repository/Storage），configure-runtime-data-environment
// 只做 userData 判定 —— 二者都不会把业务模块提前带进 import graph。
import { registerAttachmentScheme } from './bootstrap/AttachmentScheme'
import { configureRuntimeDataEnvironment } from './bootstrap/configure-runtime-data-environment'

// Phase 1：必须同步、最早执行。任何 await / microtask / dynamic import 之前。
registerAttachmentScheme()

configureRuntimeDataEnvironment()

// 动态 import 在 tsc(commonjs) 下编译为延迟 require，天然满足「先配置、后加载」。
void import('./bootstrap/main').catch((err) => {
  console.error('[entry] failed to load bootstrap/main:', err)
  process.exitCode = 1
})
