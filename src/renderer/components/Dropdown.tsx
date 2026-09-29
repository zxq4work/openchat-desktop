import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'

export interface DropdownOption {
  value: string
  label: string
  // 辅助说明文本（如 reasoning effort 的服务器 description）：仅作 hover tooltip，
  // 绝不作为主文本。
  description?: string
  // 失效选项（如历史绑定的 Provider 已不兼容）：可选但不可重新选中。
  disabled?: boolean
  // 失效/警告样式（warning 图标 + 警告色文本），仅用于展示当前无效绑定。
  invalid?: boolean
}

interface DropdownProps {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  ariaLabel?: string
  title?: string
  // 整体禁用触发器（如 binding 失效时不允许编辑依赖当前 Model 的参数）。
  disabled?: boolean
  // 可选：popup 严格等于 trigger 实测宽度（minWidth/maxWidth 双向夹死，内容不得撑宽）。
  // 默认 false = 保持现状（minWidth = trigger，允许按 option 内容更宽）。
  // 仅用于 Settings 全宽表单控件，避免超长 option 把 popup 撑出 modal 视觉边界。
  matchTriggerWidth?: boolean
}

interface MenuPosition {
  top?: number
  bottom?: number
  left: number
  // 菜单最小宽度 = trigger 实测宽度（不低于 trigger）。
  minWidth: number
  // 菜单最大宽度 = viewport 安全区（仅防止越出窗口，不做产品级宽度限制）。
  maxWidth: number
  maxHeight: number
  // 仅 matchTriggerWidth=true 时存在：popup 的固定宽度（= trigger 实测宽度）。
  // 缺省（undefined）时不设内联 width，由 CSS width:max-content 决定。
  width?: number
}

const MENU_GAP = 6
const EDGE_PADDING = 8
const MAX_MENU_HEIGHT = 320

// 真实 overflow 判断（纯函数，便于单测）：以元素实际渲染宽度为准，
// 绝不用字符串长度 / 字符数近似 —— 字体、窗口宽度、中英文、selector 宽度都会影响。
// 只应传入真正承载文本、且设置了 overflow:hidden + ellipsis 的元素
// （trigger 用 .dropdown-value，option 用其 button 本身）。
export function isElementOverflowing(
  el: { scrollWidth: number; clientWidth: number } | null | undefined
): boolean {
  if (!el) return false
  return el.scrollWidth > el.clientWidth
}

// hover 时的 title 规则（纯函数，便于单测）。优先级：
//   1. 显式 title（consumer 语义，最高）
//   2. description（功能性说明，不受 overflow 限制）
//   3. 仅当 label 实际 overflow 时，用完整 label 补偿 ellipsis
//   4. 否则 undefined（组件据此移除旧 title）
export function resolveHoverTitle(input: {
  explicitTitle?: string | null
  description?: string | null
  label: string
  overflowing: boolean
}): string | undefined {
  if (input.explicitTitle) return input.explicitTitle
  if (input.description) return input.description
  return input.overflowing ? input.label : undefined
}

// 同步 title 到目标元素：有 title 则设置，否则移除（清掉可能残留的旧 fallback title）。
// 抽成独立函数以便单测「从 overflow 变为 non-overflow 时旧 title 被移除」。
export function applyHoverTitle(
  el: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void } | null | undefined,
  title: string | undefined
): void {
  if (!el) return
  if (title) el.setAttribute('title', title)
  else el.removeAttribute('title')
}

// 菜单几何计算（纯函数，便于单测）。
// 与 trigger 的关系是「至少同宽」而非「严格同宽」：
//   minWidth = trigger 实测宽度 —— 菜单不会比 trigger 窄；
//   菜单宽度本身由内容（flex 布局下的 max-content）自然决定，可超过 minWidth；
//   maxWidth = viewport 安全区（window.innerWidth - 2*EDGE_PADDING）—— 仅保证菜单不越出
//   窗口；共享 Dropdown 不认识任何业务场景（Composer / Settings），因此不设产品级宽度上限。
//   到顶后 option 内容 ellipsis，绝不让异常长 option 撑出屏幕。
// 水平定位：默认左边缘与 trigger 左边缘对齐；只有当「菜单实际宽度」会越出 viewport
// 右安全区时，才向左移动到刚好不越界的量。这里用实测 menuWidth（缺省回退 minWidth），
// 绝不用 maxWidth 上限去预留 —— 否则窄菜单靠右时会被按上限提前大幅左移。
// matchTriggerWidth=true（opt-in，默认 false）：宽度锁死为 trigger 宽度（min=max=width），
// 内容只能在其内 ellipsis；仅用于 Settings 全宽表单控件，防止超长 option 撑出 modal 边界。
// 默认 false 时行为完全不变。
export function computeMenuGeometry(input: {
  triggerWidth: number
  triggerLeft: number
  triggerTop: number
  triggerBottom: number
  viewportWidth: number
  viewportHeight: number
  // 实测的 popup 渲染宽度（max-content 结果）。首帧尚未测量时缺省，退化为 minWidth，
  // 先对齐 trigger，随后由实测宽度做精确左移修正。
  menuWidth?: number
  // true → popup 严格等于 trigger 宽度（minWidth = maxWidth = width = triggerWidth），
  // 内容不得撑宽；仅用于 Settings 全宽表单控件，防止超长 option 撑出 modal 边界。
  matchTriggerWidth?: boolean
}): MenuPosition {
  const { triggerWidth, triggerLeft, triggerTop, triggerBottom, viewportWidth, viewportHeight, menuWidth, matchTriggerWidth } = input
  // viewport 安全区：左右各留 EDGE_PADDING，仅防止菜单越出窗口。
  const maxWidth = Math.max(0, viewportWidth - EDGE_PADDING * 2)
  // 下限不超过上限（极端窄视口下，宁可丢下限也不越界）。
  const minWidth = Math.max(0, Math.min(triggerWidth, maxWidth))

  // matchTriggerWidth：宽度锁死为 trigger 宽度（min = max = width），内容只能在其内 ellipsis。
  // 否则：参与水平 clamp 的宽度优先用实测渲染宽度（天然 ≤ maxWidth），缺省用 minWidth。
  const clampWidth = matchTriggerWidth
    ? minWidth
    : menuWidth && menuWidth > 0
      ? Math.min(menuWidth, maxWidth)
      : minWidth

  const spaceBelow = viewportHeight - triggerBottom
  const spaceAbove = triggerTop
  // 下方空间不足且上方更宽时，向上翻转
  const placeAbove = spaceBelow < spaceAbove

  const geom: MenuPosition = {
    // 默认与 trigger 左边缘对齐；仅当实际宽度将越出右安全区时，向左移动到刚好不越界。
    left: Math.max(EDGE_PADDING, Math.min(triggerLeft, viewportWidth - EDGE_PADDING - clampWidth)),
    minWidth,
    maxWidth,
    maxHeight: Math.max(
      60,
      Math.min(MAX_MENU_HEIGHT, (placeAbove ? spaceAbove : spaceBelow) - MENU_GAP - EDGE_PADDING)
    ),
  }

  if (matchTriggerWidth) {
    // 固定宽度：min/max 同值，内容无法撑宽；超长 option 在 trigger 宽度内 ellipsis。
    geom.width = minWidth
    geom.minWidth = minWidth
    geom.maxWidth = minWidth
  }

  if (placeAbove) {
    geom.bottom = viewportHeight - triggerTop + MENU_GAP
  } else {
    geom.top = triggerBottom + MENU_GAP
  }

  return geom
}

export function Dropdown({
  value,
  options,
  onChange,
  className,
  placeholder,
  ariaLabel,
  title,
  disabled,
  matchTriggerWidth,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition>({
    left: 0,
    minWidth: 0,
    maxWidth: 0,
    maxHeight: MAX_MENU_HEIGHT,
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 真正承载文本、会发生 ellipsis 的元素（trigger 内的 value span）。
  const valueRef = useRef<HTMLSpanElement>(null)
  // 打开时的 trigger 实测矩形：供「菜单实测宽度变化后重新定位」复用，避免重复读 DOM。
  const triggerRectRef = useRef<{ width: number; left: number; top: number; bottom: number } | null>(null)

  const selected = options.find((o) => o.value === value)

  const close = useCallback(() => setOpen(false), [])

  const openMenu = useCallback(() => {
    const trigger = rootRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    triggerRectRef.current = { width: rect.width, left: rect.left, top: rect.top, bottom: rect.bottom }
    // 首帧尚未知道菜单实际宽度：先用 trigger 宽度定位（左缘对齐 trigger），
    // 随后 useLayoutEffect 读取实测宽度做「刚好不越界」的精确左移修正。
    setPosition(
      computeMenuGeometry({
        triggerWidth: rect.width,
        triggerLeft: rect.left,
        triggerTop: rect.top,
        triggerBottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        matchTriggerWidth,
      })
    )
    setOpen(true)
  }, [matchTriggerWidth])

  // 菜单挂载 / 内容变化后，用实测渲染宽度重新计算左边界：
  // 只有实际宽度会越出 viewport 右安全区时才左移，左移量只为消除真实 overflow。
  // 该测量仅服务于 popup positioning，绝不回流到 trigger sizing。
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const rect = triggerRectRef.current
    if (!menu || !rect) return

    const next = computeMenuGeometry({
      triggerWidth: rect.width,
      triggerLeft: rect.left,
      triggerTop: rect.top,
      triggerBottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      // matchTriggerWidth 下宽度已锁死为 trigger 宽度，实测 menuWidth 不参与定位；
      // 其余情况用实测渲染宽度做「刚好不越界」的精确左移修正。
      menuWidth: matchTriggerWidth ? undefined : menu.getBoundingClientRect().width,
      matchTriggerWidth,
    })
    // 仅当左边界真的需要变化时才 setState，避免无谓的重渲染循环。
    setPosition((prev) => (Math.abs(prev.left - next.left) > 0.5 ? next : prev))
  }, [open, options, matchTriggerWidth])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      close()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const handleResize = () => close()
    // 触发按钮所在容器滚动时（如设置弹窗），菜单会与按钮错位，直接关闭
    const handleScroll = (e: Event) => {
      const target = e.target
      // 菜单自身滚动不关闭
      if (menuRef.current && target instanceof Node && menuRef.current.contains(target)) return
      // 只有按钮所在容器滚动时才关闭（按钮位置变化导致菜单错位）
      // 无关容器的滚动（如流式回答时消息列表自动滚动）不应关闭菜单
      if (rootRef.current && target instanceof Node && !target.contains(rootRef.current)) return
      close()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, close])

  const handleSelect = (v: string) => {
    onChange(v)
    close()
  }

  return (
    <div
      ref={rootRef}
      className={`dropdown${open ? ' open' : ''}${className ? ` ${className}` : ''}${disabled ? ' disabled' : ''}`}
    >
      <button
        type="button"
        className="dropdown-trigger"
        disabled={disabled}
        onClick={() => (disabled ? undefined : open ? close() : openMenu())}
        // 显式 title / description 是功能性说明，静态挂在 trigger button 上；
        // label 的补偿 title 只在真正 overflow 时由 hover 动态挂到 button 上。
        title={title ?? selected?.description}
        onMouseEnter={(e) => {
          // 测量对象是真正承载文本、发生 ellipsis 的 .dropdown-value；
          // 但动态 title 挂到 trigger button 上（span 只用于测量，不设 title）。
          if (title || selected?.description) return
          applyHoverTitle(
            e.currentTarget,
            resolveHoverTitle({
              label: selected ? selected.label : placeholder ?? '请选择',
              overflowing: isElementOverflowing(valueRef.current),
            })
          )
        }}
        onMouseLeave={(e) => {
          // 只清理动态挂载的 fallback title；description / 显式 title 是静态的，保留。
          // 每次离开都清掉，下一次 hover 按当前宽度重新判断。
          if (title || selected?.description) return
          e.currentTarget.removeAttribute('title')
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span
          ref={valueRef}
          className={`dropdown-value${selected ? '' : ' placeholder'}${selected?.invalid ? ' invalid' : ''}`}
        >
          {selected ? selected.label : placeholder ?? '请选择'}
        </span>
        <span className="dropdown-caret" aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="dropdown-menu"
            role="listbox"
            style={{
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              // matchTriggerWidth 下 width 存在（= trigger 宽度），popup 严格同宽；
              // 缺省则不设 width，菜单宽度由内容（flex 列中每项 max-content）自然决定，
              // 只夹住下限（不低于 trigger）与上限（viewport 安全区）。
              width: position.width,
              minWidth: position.minWidth,
              maxWidth: position.maxWidth,
              maxHeight: position.maxHeight,
            }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                disabled={opt.disabled}
                // description 功能性说明静态挂载；label 补偿 title 仅在真正 overflow 时挂载。
                title={opt.description}
                onMouseEnter={(e) => {
                  if (opt.description) return
                  applyHoverTitle(
                    e.currentTarget,
                    resolveHoverTitle({
                      label: opt.label,
                      overflowing: isElementOverflowing(e.currentTarget),
                    })
                  )
                }}
                onMouseLeave={(e) => {
                  if (opt.description) return
                  e.currentTarget.removeAttribute('title')
                }}
                className={`dropdown-item${opt.value === value ? ' selected' : ''}${opt.invalid ? ' invalid' : ''}${opt.disabled ? ' disabled' : ''}`}
                onClick={() => { if (!opt.disabled) handleSelect(opt.value) }}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
