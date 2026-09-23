// 跨平台快捷键展示 helper（仅供 UI 显示，不参与快捷键判定）。
//
// 为什么单独放一份 spec：快捷键的「真实定义」不在一处 ——
//   - 搜索会话：App.tsx 的 window keydown（isMod && shiftKey && F）
//   - 新对话：main 进程 before-input-event（ctrl/meta + N）
// 这里集中登记它们用于展示，改快捷键时只需同步这一处注释与 spec，
// 避免在组件里散落 'CmdOrCtrl+Shift+F' 这类字符串。

export interface ShortcutSpec {
  // 语义修饰键，格式化时按平台渲染（不带平台判断）
  mod: boolean
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  // 主键：'F' / 'N' 等
  key: string
}

// 搜索会话：App.tsx `isGlobalSearch = isMod && e.shiftKey && (F/f)`
export const SEARCH_CONVERSATIONS_SHORTCUT: ShortcutSpec = { mod: true, shift: true, key: 'F' }
// 新对话：main.ts `before-input-event`（key === 'n' && (control || meta)）
export const NEW_CONVERSATION_SHORTCUT: ShortcutSpec = { mod: true, key: 'N' }

// 运行平台判断。Renderer 无法访问 process，但能读 navigator.userAgent。
// 预热一次即可（平台运行期不变）。
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = `${navigator.userAgent || ''} ${navigator.platform || ''}`
  return /mac/i.test(ua)
}

// 把 spec 渲染成当前平台的展示字符串。
//   macOS：符号 + 无分隔，如 ⌘⇧F
//   Windows/Linux：Ctrl+Shift+F（可读、可对照物理键位）
export function formatShortcut(spec: ShortcutSpec, mac: boolean = isMacPlatform()): string {
  if (mac) {
    let out = ''
    if (spec.ctrl) out += '⌃'
    if (spec.alt) out += '⌥'
    if (spec.shift) out += '⇧'
    if (spec.mod) out += '⌘'
    return out + spec.key.toUpperCase()
  }
  const parts: string[] = []
  // mod 在非 mac 上即 Ctrl；与显式 ctrl 合并，避免出现 Ctrl+Ctrl
  if (spec.mod || spec.ctrl) parts.push('Ctrl')
  if (spec.alt) parts.push('Alt')
  if (spec.shift) parts.push('Shift')
  parts.push(spec.key.toUpperCase())
  return parts.join('+')
}
