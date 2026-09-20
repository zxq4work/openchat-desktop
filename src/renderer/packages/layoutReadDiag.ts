/**
 * Layout-read diagnostic — Forced Reflow trigger point localization
 *
 * Minimal, temporary instrumentation. Does NOT modify production behavior.
 * Only logs when: (1) within conversation switch probe window, AND (2) read takes >2ms.
 *
 * Usage:
 *   import { probeLayoutRead, markConversationSwitch } from './layoutReadDiag'
 *
 *   // At conversation switch entry:
 *   markConversationSwitch()
 *
 *   // Around each geometry read:
 *   const t0 = performance.now()
 *   const val = el.scrollHeight
 *   probeLayoutRead(t0, 'MessageList.scrollToBottom', 'scrollHeight')
 */

let probeUntil = 0

// 临时诊断消融实验 flag：会话切换诊断窗口内禁止 MessageList 自动触底相关 geometry 读取/写入。
// 目的：判断 130~160ms Forced Reflow 是自动触底造成的 layout thrashing，还是 A 大型 DOM 本身的 layout 成本。
// 实验结束后删除整个文件。
// 已恢复 false：scroll 消融实验完成，正式自动触底逻辑重新生效。
export const DIAG_DISABLE_SWITCH_AUTOBOTTOM = false

export function markConversationSwitch(): void {
  probeUntil = performance.now() + 1000
}

export function probeLayoutRead(
  t0: number,
  source: string,
  property: string,
): void {
  const dt = performance.now() - t0
  if (dt > 2 && performance.now() < probeUntil) {
    console.log('[perf] layout-read|source=%s.%s duration=%.1fms', source, property, dt)
  }
}

/** Check if we're still inside the probe window (for conditional instrumentation) */
export function isInProbeWindow(): boolean {
  return performance.now() < probeUntil
}

/** 诊断窗口内禁止自动触底（仅影响会话切换后 1000ms，不影响用户滚动/handleScroll） */
export function isConversationSwitchDiagActive(): boolean {
  return DIAG_DISABLE_SWITCH_AUTOBOTTOM && performance.now() < probeUntil
}

// ============================================================
// Conversation-switch 分阶段耗时埋点（纯诊断，不改变功能）
// 目标：拆开 cache hit → store 写 → React commit(pane visible) → scroll restore → finish，
//       定位 300ms 究竟花在 React 渲染/commit 还是 scrollTop restore 的 forced layout。
// ============================================================

interface SwitchTimeline {
  id: string
  t0: number
  marks: { [stage: string]: number }
  details: { [key: string]: number }
}

let activeTimeline: SwitchTimeline | null = null

/** 开始在切换入口（cache hit 命中时）调用一次。t0 缺省用当前时间。 */
export function switchTimingBegin(id: string, t0?: number): void {
  activeTimeline = { id, t0: t0 ?? performance.now(), marks: {}, details: {} }
}

/** 标记一个阶段时间点（同名只记第一次，避免 pane-visible 被多次 effect 覆盖）。 */
export function switchTimingMark(id: string, stage: string): void {
  if (!activeTimeline || activeTimeline.id !== id) return
  if (activeTimeline.marks[stage] == null) {
    activeTimeline.marks[stage] = performance.now()
  }
}

/** 记录一个耗时明细（如 restore 的 read/write cost）。 */
export function switchTimingDetail(id: string, key: string, value: number): void {
  if (!activeTimeline || activeTimeline.id !== id) return
  activeTimeline.details[key] = value
}

/** 结束并打印整条时间线。 */
export function switchTimingEnd(id: string): void {
  const tl = activeTimeline
  if (!tl || tl.id !== id) return
  const rel = (stage: string) => (tl.marks[stage] != null ? Math.round(tl.marks[stage] - tl.t0) : null)
  const between = (a: string, b: string) =>
    (tl.marks[a] != null && tl.marks[b] != null) ? Math.round(tl.marks[b] - tl.marks[a]) : null
  const fmt = (v: number | null) => (v == null ? 'n/a' : String(v))
  const fmtMs = (k: string) =>
    tl.details[k] != null ? tl.details[k].toFixed(1) : 'n/a'
  console.log(
    '[perf] switch-stages id=%s | cacheHit->storeWrite=%sms storeWrite->paneVisible=%sms ' +
    'cacheHit->paneVisible=%sms paneVisible->restoreEnd=%sms | restoreReadCost=%sms ' +
    'restoreWriteCost=%sms | cacheHit->finish=%sms',
    tl.id.slice(0, 8),
    fmt(between('begin', 'store-write')),
    fmt(between('store-write', 'pane-visible')),
    fmt(rel('pane-visible')),
    fmt(between('pane-visible', 'restore-end')),
    fmtMs('restore-read-cost'),
    fmtMs('restore-write-cost'),
    fmt(rel('finish')),
  )
  activeTimeline = null
}

// ============================================================
// keep-alive render stage timeline（纯诊断）
// 目的：拆开 paneVisible → 双 rAF → visibility 恢复 → 下一帧，
//       定位 200~300ms 落在哪一个帧边界之间（渲染/回调调度/合成）。
// 与 switchTimeline 独立：需在 restore-end 之后继续存活（next-frame）。
// ============================================================

interface RenderTimeline {
  id: string
  mode: string
  marks: { [stage: string]: number }
}

let renderTimeline: RenderTimeline | null = null

export function renderTimingBegin(id: string, mode = 'baseline'): void {
  renderTimeline = { id, mode, marks: {} }
}

/** 同名只记第一次。 */
export function renderTimingMark(id: string, stage: string): void {
  if (!renderTimeline || renderTimeline.id !== id) return
  if (renderTimeline.marks[stage] == null) renderTimeline.marks[stage] = performance.now()
}

export function renderTimingPrint(id: string): void {
  const tl = renderTimeline
  if (!tl || tl.id !== id) return
  const m = tl.marks
  const d = (a: string, b: string) =>
    (m[a] != null && m[b] != null) ? (m[b] - m[a]).toFixed(1) : 'n/a'
  const total =
    (m['pane-visible'] != null && m['next-frame'] != null)
      ? (m['next-frame'] - m['pane-visible']).toFixed(1)
      : 'n/a'
  console.log(
    '[perf] keepalive-render-stages id=%s mode=%s\n' +
    'paneVisible->raf1=%sms\n' +
    'raf1->raf2=%sms\n' +
    'raf2->visibilityShow=%sms (set before->after=%sms)\n' +
    'visibilityShow->nextFrame=%sms\n' +
    'total=%sms',
    tl.id.slice(0, 8),
    tl.mode,
    d('pane-visible', 'raf1'),
    d('raf1', 'raf2'),
    d('raf2', 'vis-after'),
    d('vis-before', 'vis-after'),
    d('vis-after', 'next-frame'),
    total,
  )
  renderTimeline = null
}

// ============================================================
// Effect / ResizeObserver 诊断（纯诊断）
// 目标：定位 paneVisible->raf1 的 200ms 是否来自 effect 执行 / ResizeObserver / 浏览器自身渲染。
// ============================================================

/** 打印单次 effect 执行耗时；activated 表示本次是否由 isActivePane false->true 触发。 */
export function logEffectRun(
  name: string,
  id: string | undefined,
  justActivated: boolean,
  t0: number,
): void {
  const dt = performance.now() - t0
  const shortId = id ? id.slice(0, 8) : '-'
  console.log('[perf] effect id=%s name=%s cost=%sms activated=%s',
    shortId, name, dt.toFixed(1), justActivated)
}

/** 打印单次 ResizeObserver callback 诊断。 */
export function logResizeObserver(
  id: string | undefined,
  callbackCost: number,
  layoutReadCost: number,
  didScrollToBottom: boolean,
): void {
  const shortId = id ? id.slice(0, 8) : '-'
  console.log('[perf] resize-observer\nid=%s\ncallbackCost=%sms\nlayoutReadCost=%sms\nscrollToBottom=%s',
    shortId, callbackCost.toFixed(1), layoutReadCost.toFixed(1), didScrollToBottom)
}
