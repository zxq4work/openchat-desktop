// 在主进程最前端（任何业务模块加载之前）统一确定 Electron userData 目录。
//
// 设计约束：
// - 业务模块（Database / Repository / Attachment / Provider ...）继续正常使用
//   app.getPath('userData')，不感知当前是 production / development / test。
// - 环境差异只在本文件、runtime-data-environment.ts、runtime-data-plan.ts 中出现。
// - import 阶段只加载轻量模块；真正的 userData 覆盖发生在主进程启动最前端
//   （见 entry.ts → configureRuntimeDataEnvironment() → 动态 import bootstrap）。
import { app } from 'electron'
import * as fs from 'fs'
import {
  createRuntimeDataEnvironment,
  type RuntimeHost,
} from './runtime-data-environment'
import type { RuntimeDataPlan, RuntimeProfile } from './runtime-data-plan'

const realHost: RuntimeHost = {
  get isPackaged() { return app.isPackaged },
  get nodeEnv() { return process.env.NODE_ENV },
  getPath: (name) => app.getPath(name),
  setPath: (name, value) => app.setPath(name, value),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
}

const environment = createRuntimeDataEnvironment(realHost)

export function configureRuntimeDataEnvironment(): RuntimeDataPlan {
  return environment.configure()
}

export function getAppliedRuntimePlan(): RuntimeDataPlan | null {
  return environment.getPlan()
}

export function getRuntimeProfile(): RuntimeProfile | null {
  return environment.getProfile()
}
