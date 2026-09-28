import { resolveRequestParameters } from '../../shared/request-parameters/requestParameters'
import type { DynamicRequestParameterDefinition, RequestParameterProfile } from '../../shared/types/provider'

// Composer 侧的动态参数派生纯函数（供 useMemo 使用）。
// UI 只消费 sanitized profile definition；Send 时 Main 会再次权威 resolve（Renderer schema 不可信）。

// 当前 Provider Profile + Model → 最终参数定义（Provider 级 + Model override）。
export function resolveComposerParameters(
  profile: RequestParameterProfile | undefined,
  modelId: string | null
): DynamicRequestParameterDefinition[] {
  return resolveRequestParameters(profile, modelId)
}
