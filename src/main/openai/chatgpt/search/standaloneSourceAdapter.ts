// Standalone（web.run）展示来源适配（纯函数，无副作用）。
//
// 背景：Hosted 的 web_search_call.action.sources 在无 url 时会归一为
// `{ title: "内置服务: <name>", url: null, sourceType: "api" }`（见
// ChatGPTConversationService 的 Hosted 分支），UI 复用同一张来源卡片展示。
// Standalone 走 /alpha/search，当命令是 `weather` 时，数据同样来自 Codex 内置
// 天气服务，但响应 `results` 为空（天气数据只在 `output` 文本里），于是没有任何
// 来源进入 UI。
//
// 本模块把「服务端原始返回」与「OpenChat 依据真实调用补充的来源说明」在代码层面
// 明确分开：
//   - mapStandaloneServerResults：服务端 data.results → 展示条目（sourceType:'web'），
//     绝不改写/丢弃原始 results。
//   - buildWeatherServiceSource：OpenChat 依据**真实、已成功执行的 weather 命令**补充的
//     内置服务来源（sourceType:'api', url:null）。它不是服务端 results 的条目。
//
// 判定「是否使用了内置天气服务」只依据实际 commands.weather，绝不从用户提问、模型回答、
// results.length===0 或 output 关键词推断。

import type { WebSearchResultItem } from '../../../../shared/types/conversation'
import type { SearchCommands } from '../../../../shared/types/webSearch'

// Codex 内置天气服务的来源标识。与 Hosted `action.sources` 中无 url 的 api 源同名，
// 表示「Codex 内置天气查询服务」，不代表任何第三方气象机构。
const WEATHER_SERVICE_NAME = 'oai-weather'

// 服务端 data.results → 展示条目。与既有持久化映射（title/url/snippet + name/link/description
// 兜底）保持一致，sourceType 恒为 'web'。
export function mapStandaloneServerResults(rawResults: unknown[] | undefined): WebSearchResultItem[] {
  const out: WebSearchResultItem[] = []
  if (!Array.isArray(rawResults)) return out
  for (const item of rawResults) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      out.push({
        title: (typeof obj.title === 'string' ? obj.title : null) ?? (typeof obj.name === 'string' ? obj.name : null),
        url: (typeof obj.url === 'string' ? obj.url : null) ?? (typeof obj.link === 'string' ? obj.link : null),
        snippet: (typeof obj.snippet === 'string' ? obj.snippet : null) ?? (typeof obj.description === 'string' ? obj.description : null),
        sourceType: 'web',
      })
    }
  }
  return out
}

// 是否提交了非空的 weather 命令（以实际 commands 为依据）。
export function hasWeatherCommand(commands: SearchCommands | undefined): boolean {
  return !!commands && Array.isArray(commands.weather) && commands.weather.length > 0
}

// 解析 run 的 function_call arguments 为 commands；解析失败返回 undefined（不推断）。
export function parseRunCommands(argumentsJson: string | undefined): SearchCommands | undefined {
  if (!argumentsJson) return undefined
  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as SearchCommands) : undefined
  } catch {
    return undefined
  }
}

// OpenChat 依据已成功执行的 weather 调用补充的内置服务来源。结构与 Hosted 的 api 来源一致。
export function buildWeatherServiceSource(): WebSearchResultItem {
  return { title: `内置服务: ${WEATHER_SERVICE_NAME}`, url: null, snippet: null, sourceType: 'api' }
}

// Standalone run 的完整展示来源列表：
//   [服务端网页来源...] +（成功 weather 时的）唯一内置服务来源。
// weatherSucceeded 必须由「工具执行成功且确获结果」判定，失败时不补充来源。
// 同一批命令里的多个 weather 不重复添加完全相同的服务来源。
export function buildStandaloneWebSearchResults(
  commands: SearchCommands | undefined,
  rawResults: unknown[] | undefined,
  weatherSucceeded: boolean
): WebSearchResultItem[] {
  const results = mapStandaloneServerResults(rawResults)
  if (weatherSucceeded && hasWeatherCommand(commands)) {
    if (!results.some((r) => r.sourceType === 'api')) {
      results.push(buildWeatherServiceSource())
    }
  }
  return results
}
