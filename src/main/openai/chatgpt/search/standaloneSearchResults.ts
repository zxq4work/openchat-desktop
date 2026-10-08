// Standalone web.run 结果归一化（仅用于 UI 展示的 rawResults/webSearchResults）。
//
// /alpha/search 的 `results[i]` 中：
//   - `search_query` 结果：ref_id = turn{N}search{M}，snippet 是真实网页摘要；
//   - `open`（页面阅读）结果：ref_id = turn{N}view{M}，snippet 是页面 reader 元数据
//     （如 "Total lines: 545"），并非摘要。
// 两者 `type` 都是 text_result，无法靠 type 区分；ref_id 家族是稳定的结构化区分依据。
//
// 只清理 UI 展示字段：open 结果的 snippet 置空，保留 title / url / ref_id / type。
// 绝不触碰 data.output —— 其中的 reader 正文与行号是模型阅读页面所必需。

const VIEW_REF_PATTERN = /^turn\d+view\d+$/i

export function normalizeStandaloneRawResults(rawResults: unknown[]): unknown[] {
  return rawResults.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw
    const item = raw as Record<string, unknown>
    const refId = typeof item.ref_id === 'string' ? item.ref_id : ''
    if (VIEW_REF_PATTERN.test(refId)) {
      return { ...item, snippet: null }
    }
    return raw
  })
}
