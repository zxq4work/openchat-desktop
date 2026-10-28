// 历史模型归属（Model Provenance）：把「每个已完成 assistant 回合实际由哪个模型生成」
// 作为确定性的历史事实注入上下文。
//
// 背景：
//   每条 assistant 消息在创建时已把实际发起请求所用的 model 写入 DB（messages.model_id），
//   但历史重建（buildCanonicalRequest）只保留 role / content / tools，从不读取该字段。
//   最终请求里只有顶层 baseMetadata 的「Current model: <当前模型>」，没有任何逐轮模型记录。
//   于是同一会话内切换模型后，模型无法得知历史回合用过不同模型，会错误声称「自始至终同一模型」。
//
// 设计要点（安全 / 有界 / 准确 / 隔离）：
//   - 作用域严格限定在**当前上下文段**（ContextSegment）。Cmd+R / 新话题 / 系统提示词变更
//     会新建 ContextSegment：新段请求绝不能看到旧段的模型归属。resolveHistoricalModels
//     强制按 currentSegmentId 过滤，即使调用方误传整个会话数据也不会泄漏旧段。
//   - 只输出**可信元数据**：已完成回合序号、生成模型。绝不把历史用户消息原文 / 摘要写入
//     System Prompt——那是不可信内容，且旧上下文段的原文本本就隔离、不应因查询模型归属而
//     被重新注入。（用户问题与回答的关联由模型读取当前真实消息自行完成。）
//   - 模型 ID 属于用户可配置的不可信字符串：渲染前统一做安全序列化（去控制字符 / 行分隔符 /
//     双向控制符，转义引号，中性化 `<`/`>` 防止伪造 `<!-- ... -->` 结构，超长显式标注截断）。
//     只影响展示，绝不修改数据库里的真实模型 ID。
//   - 输出有**两层层级预算**：明细块（entries）自身 ≤ PROVENANCE_ENTRIES_BUDGET_CHARS（4000），
//     且最终完整文本 ≤ PROVENANCE_MAX_TOTAL_CHARS（6000，硬上限，含明细 + 摘要 + 固定段落）。
//     明细超预算时先按预算收缩重建；若收缩后仍超限（极端边界），退回**有界兜底 Provenance**
//     （作用域 + 总数 + 不同模型数 + 未知数 + 当前轮 + 不完整声明），绝不返回超限文本、绝不裸截断。
//     长会话不会无限膨胀；同模型连续回合按区间精确合并（每轮各自归属，绝不把区间首条用户
//     消息当整段）；省略摘要按**原始模型 ID** 去重后给出准确的不同模型数（展示短标签若因截断
//     碰撞无法唯一映射，会显式说明），绝不因省略而谎称整段无切换。
//   - 只统计 status==='completed' 的 assistant 回合：当前轮（pending/streaming）天然排除，
//     failed/stopped 不计入（失败事实由 History Failures 单独表达），
//     缺失 model_id 的回合标记 unknown，绝不用当前模型顶替。
//
// 轮次口径与 Search Provenance / History Failures 一致：仅 completed assistant，1-based。

import type { Message, MessageAttributionMeta } from '../../../../shared/types/conversation'

// 单条模型名渲染上限（字符）。超出显式截断标注，绝不让超长自定义模型名撑爆输出。
// 仅用于「明细区」（entries）与当前轮行；摘要区使用更短的上限（见下）。
const MAX_MODEL_LABEL_CHARS = 200
// 「逐区间明细」块（entries）自身的字符预算。注意：它**只**限制明细块，
// 不含头部 / scope / 计数 / 截断摘要 / 切换说明 / 当前轮行。
const PROVENANCE_ENTRIES_BUDGET_CHARS = 4000
// 超预算摘要中最多列出的不同模型数（避免摘要本身增长）。
const MAX_SUMMARY_MODELS = 12
// 摘要区单个模型标签上限：摘要只需可辨识，不需要完整 200 字符，避免 12 条长标签再次撑爆输出。
const MAX_SUMMARY_LABEL_CHARS = 60
// 完整 Provenance 文本的**硬性总上限**（字符，含明细 + 摘要 + 所有固定段落）。
// 明细预算在此基础上动态收缩；若收缩后仍超限（极端边界），退回有界兜底 Provenance。
// 两条路径都保证最终 text.length 永不超过此值（有回归测试断言）。
const PROVENANCE_MAX_TOTAL_CHARS = 6000
// 收缩明细预算时的安全余量，避免边界处反复逼近上限。
const TOTAL_BUDGET_SAFETY = 64

// 摘要区专用：更短的安全模型标签。
function summaryModelLabel(raw: string | null): string {
  const full = safeModelLabel(raw)
  if (full.length <= MAX_SUMMARY_LABEL_CHARS) return full
  return full.slice(0, MAX_SUMMARY_LABEL_CHARS) + '…'
}

// 判断一个持久化的 modelId 是否代表「已知模型」。
// 与 safeModelLabel 的清洗规则保持一致：去掉控制字符 / 行·段分隔符 / BOM / 双向控制符，
// 折叠空白并 trim 后，仍有非空可见内容才算已知；否则（null / '' / '   ' / '\n\t  ' / 纯控制符）
// 视为 unknown。用于消除「DB 里存了纯空白 modelId，统计当成已知模型、展示却成了 UNKNOWN」的不一致。
// 注意：本函数只做「是否已知」的判定，不修改传入的原始值——已知时保留数据库里的原始 modelId 作为身份。
function isMeaningfulModelId(raw: string | null): raw is string {
  if (raw == null) return false
  const visible = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return visible.length > 0
}

const HEADER = '<!-- OPENCHAT_MODEL_PROVENANCE_V1 -->'

// 快照语义说明：Model Provenance 是「每次生成前的历史快照」，随新回答完成而增长。
// 用于防止模型把「早期回复只统计了更少的已完成回答」误判为错误并做出不必要的更正；
// 不阻止模型纠正真正的历史归属错误（仅约束「数量差异」不构成错误）。
const SNAPSHOT_NOTE =
  'Snapshot semantics: model provenance counts are snapshots taken before each generation. ' +
  'Earlier replies may correctly report fewer completed turns. A larger count now does not imply ' +
  'that an earlier count was incorrect. (This only explains legitimate count growth over time; it ' +
  'does NOT excuse a genuine wrong model attribution — correct real attribution errors.)'

// 已完成 assistant 回合的模型归属（仅可信元数据，不含用户内容）。
export interface HistoricalModelTurn {
  // 已完成 assistant 回合序号（1-based，仅统计 completed）。
  turnIndex: number
  // assistant 消息 ID（稳定标识，仅内部使用，不渲染）。
  messageId: string
  // 该回合真实使用的模型 ID；null = 旧数据未记录（unknown），绝不推断。
  modelId: string | null
}

// 历史模型记录的作用域。Model Provenance 严格限定在**当前上下文段**（与发送给模型的
// 消息范围一致），因此不再有 conversation 级作用域——Cmd+R / 新话题 / 系统提示词变更
// 会新建 ContextSegment，新段请求绝不能看到旧段的模型归属。
export type ProvenanceScope = { kind: 'segment' }

// 构建结果 + 有界统计（供诊断日志使用，不含任何用户内容）。
export interface ModelProvenanceBuild {
  text: string
  turnCount: number
  distinctModelCount: number
  unknownCount: number
  truncated: boolean
  scope: ProvenanceScope
}

// 把「不可信模型字符串」安全地渲染成单行标签：
//   - 去除控制字符、Unicode 行/段分隔符、双向控制符，折叠空白；
//   - 中性化 < / >，避免伪造 <!-- ... --> 之类的结构分隔符；
//   - 转义双引号为单引号，避免破坏引号包裹；
//   - 超长显式标注截断（不改数据库真实值）。
function safeModelLabel(raw: string | null): string {
  if (!raw) return 'UNKNOWN (not recorded)'
  let s = raw
    // 控制字符 + C1 + 行/段分隔符 + BOM + 双向控制符
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, "'")
  if (s.length === 0) return 'UNKNOWN (not recorded)'
  if (s.length > MAX_MODEL_LABEL_CHARS) {
    s = s.slice(0, MAX_MODEL_LABEL_CHARS) + '…[truncated]'
  }
  return s
}

// 把完整 Message 映射为轻量元数据（仅段级回退路径使用；主路径走 Repo 轻量查询）。
export function toAttributionMetas(messages: Message[]): MessageAttributionMeta[] {
  return messages.map((m) => ({
    id: m.id,
    segmentId: m.segmentId,
    role: m.role,
    status: m.status,
    modelId: m.modelId,
  }))
}

// 解析每个「已完成 assistant 回合」的真实模型归属。
// **强制按 currentSegmentId 过滤**：只有属于当前上下文段的消息才被统计——这是上下文
// 隔离的硬性保证（即使调用方误传整个会话的数据，旧段也绝不会泄漏）。currentSegmentId
// 为必填；未提供时返回空（拒绝在无段边界的情况下臆造历史归属）。
// 输入按稳定升序排列（生产端由 Repo 按 created_at, rowid 排序）。
// 只统计 completed assistant；当前轮在请求构建时非 completed，天然排除。
export function resolveHistoricalModels(
  metas: MessageAttributionMeta[],
  currentSegmentId: string | undefined
): HistoricalModelTurn[] {
  const turns: HistoricalModelTurn[] = []
  if (!currentSegmentId) return turns
  let assistantTurn = 0
  for (const m of metas) {
    if (m.segmentId !== currentSegmentId) continue
    if (m.status !== 'completed') continue
    if (m.role !== 'assistant') continue
    assistantTurn++
    turns.push({
      turnIndex: assistantTurn,
      messageId: m.id,
      // 只认持久化的真实值；缺失 / 纯空白（null、''、'   '、'\n\t  '、纯控制符）统一视为 unknown，
      // 绝不回填当前模型。已知时保留数据库原始 modelId 作为身份（不改写真实值）。
      modelId: isMeaningfulModelId(m.modelId) ? m.modelId : null,
    })
  }
  return turns
}

// 是否需要注入历史模型记录。只要存在任一已完成 assistant 回合即注入：
// 跳过会让模型只看到顶层 Current model，无法区分「确实没切换」与「为省 Token 未提供历史」。
export function shouldInjectModelProvenance(turns: HistoricalModelTurn[]): boolean {
  return turns.length > 0
}

interface ModelRange {
  startTurn: number
  endTurn: number
  modelId: string | null
}

// 连续同模型的回合合并为区间。
// 本模块不再渲染用户消息，故区间合并是**无损**的：区间只声明「这些轮各自都由某模型生成」，
// 不存在把某条用户消息误当作整段统一问题的风险。
function groupTurnsIntoTurns(turns: HistoricalModelTurn[]): ModelRange[] {
  const ranges: ModelRange[] = []
  for (const t of turns) {
    const last = ranges[ranges.length - 1]
    if (last && last.modelId === t.modelId) {
      last.endTurn = t.turnIndex
      continue
    }
    ranges.push({
      startTurn: t.turnIndex,
      endTurn: t.turnIndex,
      modelId: t.modelId,
    })
  }
  return ranges
}

function renderRange(r: ModelRange): string {
  const model = `"${safeModelLabel(r.modelId)}"`
  const count = r.endTurn - r.startTurn + 1
  const span = r.startTurn === r.endTurn ? `turn #${r.startTurn}` : `turns #${r.startTurn}–#${r.endTurn}`
  const each = count > 1 ? ` (${count} separate completed answers, each generated by ${model})` : ''
  return `- ${span}: ${model}${each}`
}

function scopeLine(_scope: ProvenanceScope): string {
  return 'current context segment only'
}

// 构建注入 systemPrompt 的历史模型归属上下文。
// 返回 text 为空串表示无需注入（无已完成回合）。
export function buildModelProvenanceContext(params: {
  turns: HistoricalModelTurn[]
  currentModelId: string
  scope: ProvenanceScope
}): ModelProvenanceBuild {
  const { turns, currentModelId, scope } = params
  const distinctModelIds = new Set(
    turns.filter((t) => t.modelId !== null).map((t) => t.modelId as string)
  )
  const unknownCount = turns.filter((t) => t.modelId === null).length
  const currentLabel = `"${safeModelLabel(currentModelId)}"`

  const baseStats = {
    turnCount: turns.length,
    distinctModelCount: distinctModelIds.size,
    unknownCount,
    scope,
  }
  if (turns.length === 0) {
    return { text: '', truncated: false, ...baseStats }
  }

  const staticIntro =
    'Model attribution for COMPLETED assistant turns in the CURRENT CONTEXT SEGMENT, recorded by ' +
    'OpenChat at generation time (not inferred). Metadata only — user message text is intentionally ' +
    'NOT repeated here. This record covers the current context segment only; it does NOT describe ' +
    'earlier or other context segments (a context reset starts a fresh segment whose prior model ' +
    'attribution is NOT available here).'

  // 兜底 Provenance：当明细无论怎么收缩都无法落进硬上限时使用（极端边界防御）。
  // 只保留「有界且不会误导」的确定性元数据：作用域 + 总数 + 不同模型数 + 未知数 +
  // 当前轮声明，并显式声明明细不完整、禁止据省略记录推断「单一模型」。
  // 构造上远小于 PROVENANCE_MAX_TOTAL_CHARS：只含固定段落 + 计数（无逐轮明细、无长标签），绝不使用裸 slice。
  const buildBoundedFallback = (): string =>
    `${HEADER}
Model attribution for COMPLETED assistant turns in the CURRENT CONTEXT SEGMENT (metadata only).
Scope: ${scopeLine(scope)}
Completed assistant turns in this context segment: ${turns.length}
Distinct known models among completed turns: ${distinctModelIds.size}
Turns with no recorded model (unknown): ${unknownCount}
Per-turn attribution detail is omitted for length (ATTRIBUTION INCOMPLETE). Do NOT infer that the omitted turns used a single model — rely on the counts above, not on the absence of detail.
Current turn: model ${currentLabel} — being generated now, NOT completed, NOT counted above.
${SNAPSHOT_NOTE}`

  // ── 紧凑形态：全部已完成回合同一已知模型 ──
  // 无逐条映射需求，输出与回合数无关的常量级文本，最大化系统提示词缓存命中。
  const allSameModel =
    distinctModelIds.size === 1 && unknownCount === 0
  if (allSameModel) {
    const shared = `"${safeModelLabel(turns[0].modelId)}"`
    const sameAsCurrent = turns[0].modelId === currentModelId
    const relation = sameAsCurrent
      ? 'The model answering now is the same model.'
      : 'The model answering now is DIFFERENT — the model changed before this turn; do not describe earlier completed turns as having used the current model.'
    const text = `${HEADER}
${staticIntro}
Scope: ${scopeLine(scope)}
COMPLETED assistant turns in this context segment so far: ${turns.length}. All ${turns.length} of them used model ${shared}. NO model switch occurred among completed turns. ${relation}
Current turn: model ${currentLabel} — being generated now, NOT completed, NOT counted above.
${SNAPSHOT_NOTE}`
    // 紧凑形态同样受硬上限约束：极端超长标签下回退到有界兜底。
    if (text.length > PROVENANCE_MAX_TOTAL_CHARS) {
      return { text: buildBoundedFallback(), truncated: true, ...baseStats }
    }
    return { text, truncated: false, ...baseStats }
  }

  // ── 完整形态：出现多种模型或存在未知回合（作用域仍是当前上下文段）──
  const ranges = groupTurnsIntoTurns(turns)
  const lastTurn = turns[turns.length - 1].turnIndex
  const historyHasMultiple = distinctModelIds.size >= 2
  let switchNote: string
  if (historyHasMultiple) {
    switchNote = 'model attribution DIFFERS across completed turns (the model changed during this conversation); cite the per-turn models above, never claim a single model throughout.'
  } else if (unknownCount > 0) {
    switchNote = 'some completed turns have no recorded model; do not claim the conversation used only one model — state that earlier model records are incomplete.'
  } else {
    switchNote = 'all completed turns share the same model (see entries).'
  }

  // 把明细 + 摘要 + 固定段落组合成最终文本。entriesBudget 控制明细块字符上限；
  // 明细超出时生成带「省略范围 + 总数 + 按原始 ID 去重后的不同模型数」的截断摘要
  // （展示短标签可能因截断而不唯一，故另附说明，见 truncationFooter）。
  const compose = (entriesBudget: number): { text: string; truncated: boolean; omittedFromTurn: number } => {
    const lines: string[] = []
    let used = 0
    let truncated = false
    let omittedFromTurn = 0
    for (const r of ranges) {
      const line = renderRange(r)
      if (used + line.length + 1 > entriesBudget) {
        truncated = true
        omittedFromTurn = r.startTurn
        break
      }
      lines.push(line)
      used += line.length + 1
    }

    const truncationFooter = truncated
      ? (() => {
          // **先按原始 modelId 去重，再做展示截断**：两个不同原始 ID 即使截断到同一短标签，
          // 也必须算作两个不同模型，绝不能因展示标签碰撞而合并计数（否则会谎报「只有一种模型」）。
          const omittedRaw = new Set<string>()
          let omittedUnknown = 0
          for (const t of turns) {
            if (t.turnIndex < omittedFromTurn) continue
            if (t.modelId === null) {
              // unknown 与任何已知模型都不同：单独计数，绝不并入模型标签集合。
              omittedUnknown++
            } else {
              omittedRaw.add(t.modelId)
            }
          }
          const rawIds = [...omittedRaw].sort()
          const distinctKnown = rawIds.length
          // 生成展示标签并检测截断碰撞：不同原始 ID 却得到同一短标签即为碰撞。
          const labelCount = new Map<string, number>()
          for (const id of rawIds) {
            const label = summaryModelLabel(id)
            labelCount.set(label, (labelCount.get(label) ?? 0) + 1)
          }
          const labels = [...labelCount.keys()]
          const labelCollision = [...labelCount.values()].some((n) => n > 1)
          const shownLabels = labels.slice(0, MAX_SUMMARY_MODELS)
          const more = labels.length > MAX_SUMMARY_MODELS ? ` and ${labels.length - MAX_SUMMARY_MODELS} more` : ''
          // 不同模型数使用**原始 ID 去重后的准确值**，展示标签仅作参考。
          const knownPart =
            distinctKnown > 0
              ? ` Distinct models observed in the omitted range: ${distinctKnown}${shownLabels.length > 0 ? ` (${shownLabels.join(', ')}${more})` : ''}.`
              : ''
          const unknownPart =
            omittedUnknown > 0 ? ` ${omittedUnknown} omitted turn(s) have no recorded model (unknown).` : ''
          const collisionNote = labelCollision
            ? ' Some distinct model IDs share identical truncated display labels; the labels cannot be uniquely mapped to raw IDs — treat the distinct count as authoritative.'
            : ''
          return `\n[ATTRIBUTION INCOMPLETE: per-turn detail for turns #${omittedFromTurn}–#${lastTurn} is omitted for length. Total completed assistant turns: ${turns.length}. Do NOT infer that omitted turns used a single model.${knownPart}${unknownPart}${collisionNote}]`
        })()
      : ''

    const text = `${HEADER}
${staticIntro} Each entry covers separate, independently generated answers; entries are in generation order.
Scope: ${scopeLine(scope)}
Completed assistant turns in this context segment: ${turns.length}

${lines.join('\n')}
${truncationFooter}
Model attribution across completed turns: ${switchNote}
Current turn: model ${currentLabel} — being generated now, NOT completed, NOT counted above; never list it as a completed answer.
${SNAPSHOT_NOTE}`
    return { text, truncated, omittedFromTurn }
  }

  // 先按明细预算构建；若最终全文超过硬上限，按超出量收缩明细预算重建（至多数次）。
  // 正常数据下收缩会收敛到 ≤ PROVENANCE_MAX_TOTAL_CHARS；固定段落 + 摘要脚注本身很小，
  // 但 guard 用尽或 budget 触 0 的极端边界仍可能超限，故下方保留兜底。
  let budget = PROVENANCE_ENTRIES_BUDGET_CHARS
  let result = compose(budget)
  let guard = 0
  while (result.text.length > PROVENANCE_MAX_TOTAL_CHARS && budget > 0 && guard < 8) {
    const overflow = result.text.length - PROVENANCE_MAX_TOTAL_CHARS + TOTAL_BUDGET_SAFETY
    budget = Math.max(0, budget - overflow)
    result = compose(budget)
    guard++
  }

  // **最终硬保证**：收缩循环可能因 guard 用尽或 budget 触 0 仍超限（例如固定段落 +
  // 很长的摘要脚注本身就逼近上限）。此时绝不返回超限文本，也绝不裸 slice，而是退回
  // 明确、简短、有界、且不会误导的兜底 Provenance，并标记 truncated。
  if (result.text.length > PROVENANCE_MAX_TOTAL_CHARS) {
    return { text: buildBoundedFallback(), truncated: true, ...baseStats }
  }

  return { text: result.text, truncated: result.truncated, ...baseStats }
}