// 最小 Electron 主进程入口。
//
// 这是 main process 真正的启动边界：
//   1. 先确定 userData 目录（production 不改 / development → openchat-desktop-dev / test → 临时目录）
//   2. 再动态 import bootstrap/main，使其及其全部业务依赖在 userData 配置完成之后才加载。
//
// 为什么必须动态 import：ESM / CJS 的静态 import 会在当前模块主体执行前先加载依赖链。
// 若这里直接静态 `import './bootstrap/main'`，bootstrap 依赖链中任何
// `app.getPath('userData')`（即便是模块顶层缓存）都会在 userData 覆盖前拿到 production 路径。
// 动态 import 保证顺序：configureRuntimeDataEnvironment() 先于 bootstrap 加载。
import { configureRuntimeDataEnvironment } from './bootstrap/configure-runtime-data-environment'

configureRuntimeDataEnvironment()

// 动态 import 在 tsc(commonjs) 下编译为延迟 require，天然满足「先配置、后加载」。
void import('./bootstrap/main').catch((err) => {
  console.error('[entry] failed to load bootstrap/main:', err)
  process.exitCode = 1
})
