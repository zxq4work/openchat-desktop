// userData 隔离的「状态机」实现，刻意不 import electron，
// 以便在普通单元测试中通过注入假 host 验证幂等与路径判定。
//
// 真实 Electron 绑定见 configure-runtime-data-environment.ts。
import * as os from 'os'
import * as path from 'path'
import {
  resolveRuntimeDataPlan,
  type RuntimeDataPlan,
  type RuntimeProfile,
} from './runtime-data-plan'

// host 抽象：生产走真实 electron（app / fs），测试注入假实现。
export interface RuntimeHost {
  isPackaged: boolean
  nodeEnv?: string
  getPath(name: 'userData'): string
  setPath(name: 'userData', value: string): void
  mkdir(path: string): void
  mkdtemp(prefix: string): string
}

export interface RuntimeDataEnvironment {
  configure(): RuntimeDataPlan
  getPlan(): RuntimeDataPlan | null
  getProfile(): RuntimeProfile | null
}

export function createRuntimeDataEnvironment(host: RuntimeHost): RuntimeDataEnvironment {
  // 进程级单例：同一进程重复调用必须幂等（绝不产生 openchat-desktop-dev-dev）。
  let applied: RuntimeDataPlan | null = null

  function logRuntimePlan(plan: RuntimeDataPlan): void {
    console.log(`[Runtime] profile=${plan.profile}`)
    if (plan.profile === 'production') return
    // development 额外输出切换前的默认目录，便于验收「确已切换」。
    console.log(`[Runtime] defaultUserData=${plan.defaultUserDataPath}`)
    console.log(`[Runtime] userData=${plan.userDataPath}`)
  }

  return {
    configure(): RuntimeDataPlan {
      if (applied) return applied

      // 必须在覆盖前读取真实默认目录（production 下即当前已有数据所在目录）。
      const defaultUserDataPath = host.getPath('userData')

      // test profile 需要真实临时目录；每个进程/worker 独立，避免并发共享同一 test DB。
      // 注意：仅未打包时创建 —— packaged app 永远 production，不得调用 mkdtemp。
      const testTempPath = !host.isPackaged && host.nodeEnv === 'test'
        ? host.mkdtemp(path.join(os.tmpdir(), 'openchat-test-'))
        : undefined

      const plan = resolveRuntimeDataPlan({
        isPackaged: host.isPackaged,
        nodeEnv: host.nodeEnv,
        defaultUserDataPath,
        testTempPath,
      })

      if (plan.shouldOverrideUserData && plan.userDataPath) {
        // setPath 前确保目标存在（Electron 不会自动创建 userData 目录）。
        host.mkdir(plan.userDataPath)
        host.setPath('userData', plan.userDataPath)
      }

      applied = plan
      logRuntimePlan(plan)
      return plan
    },

    getPlan(): RuntimeDataPlan | null {
      return applied
    },

    getProfile(): RuntimeProfile | null {
      return applied?.profile ?? null
    },
  }
}
