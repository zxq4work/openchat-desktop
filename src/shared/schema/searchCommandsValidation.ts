// web.run 命令参数校验（纯函数，无副作用）。
//
// 目的：在把 commands 发往 /backend-api/codex/alpha/search 之前，拦下**已知不受支持**的字段，
// 避免上游直接 400（如 Unknown parameter: 'commands.weather[0].date'）。
//
// 原则：
//   - 只校验「有官方依据」的命令族，绝不猜测未知命令族的字段，避免误拒合法请求。
//   - 校验失败时**不静默删除/改写**用户明确给出的参数，而是明确报错，交由模型用合法参数重试。
//
// 当前已知依据（codex-rs/codex-api/src/search.rs）：
//   WeatherOperation = { location: string(必填), start?: string, duration?: number }，不存在 date。

import type { SearchCommands } from '../types/webSearch'

export interface SearchCommandsValidation {
  ok: boolean
  error?: string
}

// 官方 WeatherOperation 允许的字段（精确匹配，其余一律视为不受支持）。
const WEATHER_ALLOWED_KEYS = ['location', 'start', 'duration'] as const
const WEATHER_ALLOWED_SET = new Set<string>(WEATHER_ALLOWED_KEYS)

export function validateSearchCommands(commands: SearchCommands): SearchCommandsValidation {
  const weather = commands.weather
  if (Array.isArray(weather)) {
    for (let i = 0; i < weather.length; i++) {
      const item = weather[i] as unknown as Record<string, unknown> | null | undefined
      if (!item || typeof item !== 'object') {
        return { ok: false, error: `commands.weather[${i}] must be an object` }
      }

      const unknown = Object.keys(item).filter((k) => !WEATHER_ALLOWED_SET.has(k))
      if (unknown.length > 0) {
        return {
          ok: false,
          error:
            `Unknown parameter: 'commands.weather[${i}].${unknown[0]}'. ` +
            `weather supports only: ${WEATHER_ALLOWED_KEYS.join(', ')}.`,
        }
      }

      const location = item.location
      if (typeof location !== 'string' || location.trim() === '') {
        return { ok: false, error: `commands.weather[${i}].location is required and must be a non-empty string` }
      }
      if (item.start !== undefined && typeof item.start !== 'string') {
        return { ok: false, error: `commands.weather[${i}].start must be a string` }
      }
      if (item.duration !== undefined && typeof item.duration !== 'number') {
        return { ok: false, error: `commands.weather[${i}].duration must be a number` }
      }
    }
  }

  return { ok: true }
}
