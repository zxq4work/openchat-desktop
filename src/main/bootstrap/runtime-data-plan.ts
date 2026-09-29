// 纯函数：计算「本次运行应该使用哪个 userData 目录」。
// 不 import electron / fs，保持可被普通单元测试直接引用，
// 从而 Runtime 路径规则无需启动 Electron 即可验证。
import * as path from 'path'

export type RuntimeProfile = 'production' | 'development' | 'test'

export interface RuntimeDataPlanInput {
  isPackaged: boolean
  nodeEnv?: string
  defaultUserDataPath: string
  // 仅 test profile 使用：由调用方（configure-runtime-data-environment）
  // 通过 mkdtempSync 生成的真实临时目录，保证每个进程/worker 独立。
  testTempPath?: string
}

export interface RuntimeDataPlan {
  profile: RuntimeProfile
  defaultUserDataPath: string
  userDataPath: string
  shouldOverrideUserData: boolean
  temporary: boolean
}

// development 目录后缀。基于真实默认目录推导（dirname/basename），
// 不硬编码 macOS / Windows 用户目录。
export const DEVELOPMENT_USER_DATA_SUFFIX = '-dev'

// 优先级：isPackaged 最高。
// 正式安装包（isPackaged=true）永远 production —— 即便其父进程/CI/IDE 带有
// NODE_ENV=test，也绝不能把正式程序切到临时目录。production 的 userData
// 是最高兼容边界，任何环境变量都无权覆盖它。
export function resolveRuntimeProfile(
  input: Pick<RuntimeDataPlanInput, 'isPackaged' | 'nodeEnv'>
): RuntimeProfile {
  if (input.isPackaged) return 'production'
  if (input.nodeEnv === 'test') return 'test'
  return 'development'
}

export function deriveDevelopmentUserDataPath(defaultUserDataPath: string): string {
  return path.join(
    path.dirname(defaultUserDataPath),
    `${path.basename(defaultUserDataPath)}${DEVELOPMENT_USER_DATA_SUFFIX}`
  )
}

export function resolveRuntimeDataPlan(input: RuntimeDataPlanInput): RuntimeDataPlan {
  const profile = resolveRuntimeProfile(input)

  if (profile === 'production') {
    // production 绝不重新指定 userData —— 保持 Electron 原生路径（当前已有数据所在目录）。
    return {
      profile,
      defaultUserDataPath: input.defaultUserDataPath,
      userDataPath: input.defaultUserDataPath,
      shouldOverrideUserData: false,
      temporary: false,
    }
  }

  if (profile === 'test') {
    // 临时目录由调用方注入。未注入时不覆盖（保持纯函数语义，不在此推导固定目录，
    // 避免出现长期共享的 OpenChat-Test）。
    const tempPath = input.testTempPath ?? ''
    return {
      profile,
      defaultUserDataPath: input.defaultUserDataPath,
      userDataPath: tempPath,
      shouldOverrideUserData: tempPath.length > 0,
      temporary: true,
    }
  }

  const developmentUserDataPath = deriveDevelopmentUserDataPath(input.defaultUserDataPath)
  return {
    profile,
    defaultUserDataPath: input.defaultUserDataPath,
    userDataPath: developmentUserDataPath,
    shouldOverrideUserData: developmentUserDataPath !== input.defaultUserDataPath,
    temporary: false,
  }
}
