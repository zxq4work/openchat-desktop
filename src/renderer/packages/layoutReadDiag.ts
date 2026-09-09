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
