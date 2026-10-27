// 「本轮工具归因」请求拆分（纯函数，无副作用）。
//
// 目的（仅限 S1：用户在同一条消息里既要求搜索、又要求说明本轮实际使用的工具/模式）：
//   把「模型需要回答的实质问题」与「应用负责的工具归因」分开：
//     - 模型只看到实质问题（去掉句尾独立归因要求），因此没有动机在正文里报工具名；
//     - 工具归因由 OpenChat 依据本轮真实执行事件生成（见 buildHostedAttributionStatement）。
//
// 严格边界（不得放宽）：
//   - 只识别**封闭短语表**里的独立句尾片段；不做开放式自然语言改写。
//   - 代码块（```）、行内代码（`...`）、Markdown 引用（> ...）一律不拆分。
//   - 存在歧义（剥离后无实质内容 / 短语出现在句中而非句尾）一律不拆分，返回 null。
//   - 用户原始消息本身从不被修改；本模块只产出「供模型使用」的文本副本。

export interface AttributionSplit {
  // 供模型使用的实质问题（已移除命中的句尾归因片段；其余原文逐字保留）。
  modelText: string
  // 被移除的原始片段（仅用于诊断/日志，不参与归因文本生成）。
  removedClause: string
  // 命中语言，用于生成对应语言的权威说明。
  language: 'zh' | 'en'
}

// 封闭短语表：仅这些精确句式可被识别为「句尾独立归因要求」。
// 说明：
//   - 必须是句尾（允许其后只有标点/空白）；
//   - 前后允许有引导标点（，,；;。.）与少量连接词（并/且/and）；
//   - 不包含任何"任意内容"占位，避免开放式改写。
const ZH_CLAUSES: readonly string[] = [
  '并说明本轮实际使用的搜索工具名称及搜索模式',
  '并说明本轮实际使用的搜索工具及搜索模式',
  '并说明本轮实际使用的搜索工具名称',
  '并说明本轮实际使用的搜索工具',
  '并说明本轮使用的搜索工具名称及搜索模式',
  '并说明本轮使用的搜索工具及搜索模式',
  '并说明本轮使用的搜索工具名称',
  '并说明本轮使用的搜索工具',
  '并说明本轮使用的搜索模式',
  '并说明本轮实际执行的搜索工具名称及搜索模式',
  '并说明本轮实际执行的搜索工具及搜索模式',
  '并说明本轮实际执行的搜索工具名称',
  '并说明本轮实际执行的搜索工具',
  '最后说明本轮实际使用的搜索工具名称及搜索模式',
  '最后说明本轮实际使用的搜索工具及搜索模式',
  '最后说明本轮实际使用的搜索工具名称',
  '最后说明本轮实际使用的搜索工具',
  '最后说明本轮使用的搜索工具名称及搜索模式',
  '最后说明本轮使用的搜索工具及搜索模式',
  '最后说明本轮使用的搜索工具名称',
  '最后说明本轮使用的搜索工具',
  '最后说明本轮使用的搜索模式',
  '最后说明本轮实际执行的搜索工具名称及搜索模式',
  '最后说明本轮实际执行的搜索工具及搜索模式',
  '最后说明本轮实际执行的搜索工具名称',
  '最后说明本轮实际执行的搜索工具',
]

const EN_CLAUSES: readonly string[] = [
  'and state exactly which search tool or search mode you used for this turn',
  'and state which search tool or search mode you used for this turn',
  'and state exactly which search tool you used for this turn',
  'and state which search tool you used for this turn',
  'and tell me exactly which search tool or search mode you used for this turn',
  'and tell me which search tool or search mode you used for this turn',
  'and tell me exactly which search tool you used for this turn',
  'and tell me which search tool you used for this turn',
  'and mention which search tool or search mode you used for this turn',
  'and mention which search tool you used for this turn',
  'and say which search tool or search mode you used for this turn',
  'and say which search tool you used for this turn',
  'and specify which search tool or search mode you used for this turn',
  'and specify which search tool you used for this turn',
]

// 段落中若包含这些结构，说明含代码/引用，整体放弃拆分（保守）。
const UNSAFE_MARKERS: readonly RegExp[] = [
  /```/,          // 代码块围栏
  /^[ \t]*>/m,    // Markdown 引用行
  /\r?\n[ \t]*[-*+][ \t]/, // 列表项（可能承载结构性内容）
]

// 在文本尾部匹配一条封闭短语，允许尾部标点/空白。
function matchTailClause(text: string, clauses: readonly string[]): { clause: string; start: number } | null {
  const trimmedEnd = text.replace(/[\s。.!！?？]+$/, '')
  if (!trimmedEnd) return null
  for (const clause of clauses) {
    // 尾部精确匹配（大小写不敏感，仅英文需要）
    if (trimmedEnd.length < clause.length) continue
    const tail = trimmedEnd.slice(trimmedEnd.length - clause.length)
    if (tail.toLowerCase() !== clause.toLowerCase()) continue
    let start = trimmedEnd.length - clause.length
    // 允许紧邻的前导分隔标点/连接词一并移除（，,；;、 或空格）
    while (start > 0 && /[，,；;、\s]/.test(trimmedEnd[start - 1])) start--
    return { clause, start }
  }
  return null
}

// 主体在剥离后必须有实质内容（非空、且不是纯标点/连接词）。
function hasSubstance(text: string): boolean {
  const stripped = text.replace(/[\s，,。.；;！!？?、]/g, '')
  return stripped.length >= 2
}

/**
 * 识别并拆分「独立句尾归因要求」。
 * 仅当：命中封闭短语表 + 位于句尾 + 剥除后主体仍有实质内容 + 文本不含代码/引用结构时返回拆分结果；
 * 其余情况一律返回 null（调用方走原流程，绝不擅自裁剪）。
 */
export function splitAttributionRequest(rawText: string): AttributionSplit | null {
  const text = rawText ?? ''
  if (!text.trim()) return null
  if (UNSAFE_MARKERS.some((re) => re.test(text))) return null
  // 行内代码存在时同样保守放弃（避免改到 `...` 内的内容）。
  if (/`[^`\n]+`/.test(text)) return null

  for (const [language, clauses] of [['zh', ZH_CLAUSES], ['en', EN_CLAUSES]] as const) {
    const hit = matchTailClause(text, clauses)
    if (!hit) continue
    // 被移除片段的前方还必须有一个合理分隔（句读或空白），否则视为与其他内容粘连 → 放弃。
    const before = text.slice(0, hit.start)
    if (!before.trim()) return null            // 整句只有归因要求 → 无实质问题，不拆分
    if (!hasSubstance(before)) return null     // 剥除后没有实质内容 → 不拆分

    const modelText = before.replace(/[\s，,；;、]+$/, '').trimEnd()
    if (!modelText) return null
    return {
      modelText,
      removedClause: text.slice(hit.start).trim(),
      language,
    }
  }
  return null
}

// 权威归因说明（仅 Hosted）。措辞固定，由真实执行结果驱动，不由模型生成。
//   executed: 本轮确有真实 web_search_call 执行事件
//   notObserved: 本轮未观察到「已完成」的执行事件 —— 不等于确定没有搜索
//                （可能被中断、或事件未完成/未回传），故措辞必须保留不确定性。
//   failed: 观察到失败/中断
export type HostedAttributionState = 'executed' | 'notObserved' | 'failed'

export function buildHostedAttributionStatement(
  state: HostedAttributionState,
  language: 'zh' | 'en'
): string {
  if (language === 'en') {
    switch (state) {
      case 'executed':
        return 'Search tool actually used this turn: the Codex native `web_search` (execution event: `web_search_call`); search mode: Hosted Web Search.'
      case 'failed':
        return 'Search tool this turn: the Codex native `web_search` (search did not complete successfully); search mode: Hosted Web Search.'
      case 'notObserved':
        return 'No completed web search was observed this turn (a search may have been attempted but did not complete).'
    }
  }
  switch (state) {
    case 'executed':
      return '本轮实际使用的搜索工具：Codex 原生 web_search（执行事件 web_search_call）；搜索模式：Hosted Web Search。'
    case 'failed':
      return '本轮搜索工具：Codex 原生 web_search（本次搜索未成功完成）；搜索模式：Hosted Web Search。'
    case 'notObserved':
    default:
      return '本轮未观察到已完成的网络搜索（可能尝试过搜索但未完成）。'
  }
}
