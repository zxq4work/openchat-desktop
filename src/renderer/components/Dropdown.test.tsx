/**
 * Dropdown title 条件 / 宽度安全 / popup 几何 / Composer 布局契约测试。
 *
 * 背景：Dropdown 保留宽度安全修复（shrink + ellipsis + popup ≥ trigger），完整文本仍走
 * native title，且不使用共享 Tooltip。普通 label 的 title 只在「真正 overflow
 * （scrollWidth > clientWidth）」时才显示；description 是功能性说明，始终作为 title。
 *
 * 宽度策略：共享 Dropdown 不认识业务场景（Composer / Settings），因此：
 *   - trigger content-sized（宽度由当前 selected 自然决定）；
 *   - popup min-width = trigger 实测宽度，允许按 option 内容更宽；
 *   - popup 仅受 viewport 安全区约束，不设产品级宽度上限（如 440px）；
 *   - 水平定位基于菜单「实测渲染宽度」做最小左移，绝不用 maxWidth 上限提前预留。
 * Composer 的紧凑 / 收缩 / cap 全部由 `.composer-controls ...` 作用域 CSS 保证。
 *
 * 测试只验证可稳定断言的部分：纯函数（overflow / title / menu 几何）、SSR 的静态
 * title attribute、CSS contract、以及源码契约。jsdom/SSR 无可靠文本宽度与真实事件，
 * 因此不写依赖真实 layout 的几何断言，也不验证原生 title 是否真的弹出。
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import fs from 'fs'
import {
  Dropdown,
  computeMenuGeometry,
  isElementOverflowing,
  resolveHoverTitle,
  applyHoverTitle,
} from './Dropdown'

// ===== 工具 =====

function renderDropdown(props: React.ComponentProps<typeof Dropdown>): string {
  return ReactDOMServer.renderToStaticMarkup(<Dropdown {...props} />)
}

function valueText(html: string): string {
  const m = html.match(/<span class="dropdown-value[^"]*">([\s\S]*?)<\/span>/)
  if (!m) throw new Error(`dropdown-value span not found in: ${html}`)
  return m[1]
}

const GLOBAL_CSS = fs.readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8')
const DROPDOWN_SRC = fs.readFileSync(new URL('./Dropdown.tsx', import.meta.url), 'utf8')

// 提取「选择器独立出现」的规则体（这些规则都没有嵌套花括号）。
// 用行首锚定 + 后缀负向断言，避免命中选择器组里被复用的同名类：
// 例如 `.composer-controls .reasoning-selector .dropdown-trigger {…}` 不应被
// `cssRule('.dropdown-trigger')` 命中，后者必须拿到独立规则的 `.dropdown-trigger {…}`。
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = GLOBAL_CSS.match(new RegExp(`(?:^|[\\n}])\\s*${escaped}(?![\\w-])\\s*\\{([^}]*)\\}`))
  if (!m) throw new Error(`CSS rule not found: ${selector}`)
  return m[1]
}

// 构造一个可读 title 的假元素，供 applyHoverTitle / overflow 判断使用。
function makeEl(scrollWidth: number, clientWidth: number) {
  const attrs: Record<string, string> = {}
  return {
    scrollWidth,
    clientWidth,
    setAttribute: (n: string, v: string) => { attrs[n] = v },
    removeAttribute: (n: string) => { delete attrs[n] },
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
  }
}

const LONG_MODEL =
  'This is an intentionally extremely long model display name that must never push the send button outside the window'
const LONG_CJK =
  '阿迪斯发生的发生的法师打发三大发啥打法是都发啥打法额无法大师傅撒打发士大夫'
const LONG_DESC =
  'Balances speed and reasoning depth for everyday tasks, described at length by the server'

// ===== TEST 1/2/3：overflow 判断 =====

describe('isElementOverflowing — 真实 DOM 宽度判断', () => {
  it('TEST 1：scrollWidth(200) > clientWidth(100) → true', () => {
    expect(isElementOverflowing(makeEl(200, 100))).toBe(true)
  })

  it('TEST 2：scrollWidth(100) === clientWidth(100) → false', () => {
    expect(isElementOverflowing(makeEl(100, 100))).toBe(false)
  })

  it('TEST 3：scrollWidth(80) < clientWidth(100) → false', () => {
    expect(isElementOverflowing(makeEl(80, 100))).toBe(false)
  })

  it('null / undefined 安全 → false', () => {
    expect(isElementOverflowing(null)).toBe(false)
    expect(isElementOverflowing(undefined)).toBe(false)
  })
})

// ===== TEST 4/5/6：title 优先级（普通 label / description） =====

describe('resolveHoverTitle — native title 规则', () => {
  it('TEST 4：普通 option，无 description、无 overflow → undefined（不显示 title）', () => {
    expect(resolveHoverTitle({ label: 'deepseek-v4-pro', overflowing: false })).toBeUndefined()
    expect(resolveHoverTitle({ label: 'kl/glm-5.1', overflowing: false })).toBeUndefined()
  })

  it('TEST 5：普通 option，无 description、有 overflow → 完整 label', () => {
    expect(resolveHoverTitle({ label: LONG_MODEL, overflowing: true })).toBe(LONG_MODEL)
    expect(resolveHoverTitle({ label: LONG_CJK, overflowing: true })).toBe(LONG_CJK)
  })

  it('TEST 6：有 description、无 overflow → description（功能性说明不受 overflow 限制）', () => {
    expect(resolveHoverTitle({ label: 'Medium', description: LONG_DESC, overflowing: false })).toBe(LONG_DESC)
  })

  it('有 description 且 overflow → 仍为 description（description 优先于 label）', () => {
    expect(resolveHoverTitle({ label: LONG_MODEL, description: LONG_DESC, overflowing: true })).toBe(LONG_DESC)
  })
})

// ===== TEST 7：reasoning description 始终保持 =====

describe('reasoning description 不因无 ellipsis 而消失', () => {
  it('TEST 7：Medium 完整显示（无 overflow）仍保留 description', () => {
    expect(resolveHoverTitle({ label: 'Medium', description: LONG_DESC, overflowing: false })).toBe(LONG_DESC)
  })

  it('SSR：selected 有 description → trigger 静态 title = description', () => {
    const html = renderDropdown({
      value: 'medium',
      options: [{ value: 'medium', label: 'Medium', description: LONG_DESC }],
      onChange: () => {},
    })
    expect(html).toContain(`title="${LONG_DESC}"`)
    // 主文本仍是短 label，description 不进入 value
    expect(valueText(html)).toBe('Medium')
  })
})

// ===== TEST 8：显式 title 最高优先 =====

describe('显式 title 优先', () => {
  it('TEST 8：explicit 覆盖 description 与 overflow label', () => {
    expect(
      resolveHoverTitle({ explicitTitle: '请先选择可用模型', description: LONG_DESC, label: LONG_MODEL, overflowing: true })
    ).toBe('请先选择可用模型')
    expect(
      resolveHoverTitle({ explicitTitle: 'X', label: LONG_MODEL, overflowing: true })
    ).toBe('X')
  })

  it('SSR：显式 title 渲染，description 不出现', () => {
    const html = renderDropdown({
      value: 'medium',
      title: '请先选择可用模型',
      options: [{ value: 'medium', label: 'Medium', description: LONG_DESC }],
      onChange: () => {},
    })
    expect(html).toContain('title="请先选择可用模型"')
    expect(html).not.toContain(LONG_DESC)
  })
})

// ===== SSR：短文本无 title（不再有多余 native title） =====

describe('普通短文本不再设置 title', () => {
  it('无 description 的短 option：SSR 不产出 title 属性', () => {
    const html = renderDropdown({
      value: 'm',
      options: [{ value: 'm', label: 'deepseek-v4-pro' }],
      onChange: () => {},
    })
    expect(valueText(html)).toBe('deepseek-v4-pro')
    expect(html).not.toContain('title=')
  })
})

// ===== TEST 9：从 overflow 变回 non-overflow 时旧 title 被移除 =====

describe('applyHoverTitle — 属性同步与清理', () => {
  it('TEST 9：先 overflow 挂上 label title，再 non-overflow 时移除', () => {
    const el = makeEl(200, 100)

    // 第一次 hover：overflow → 挂 label
    applyHoverTitle(el, resolveHoverTitle({ label: LONG_MODEL, overflowing: isElementOverflowing(el) }))
    expect(el.getAttribute('title')).toBe(LONG_MODEL)

    // 窗口变宽 / selector 变宽后：不再 overflow → 必须清掉旧 title
    el.scrollWidth = 100
    applyHoverTitle(el, resolveHoverTitle({ label: LONG_MODEL, overflowing: isElementOverflowing(el) }))
    expect(el.getAttribute('title')).toBeNull()
  })

  it('description 场景不会被误清：（有无 overflow）始终挂 description', () => {
    const el = makeEl(100, 100)
    applyHoverTitle(el, resolveHoverTitle({ label: 'Medium', description: LONG_DESC, overflowing: isElementOverflowing(el) }))
    expect(el.getAttribute('title')).toBe(LONG_DESC)
  })

  it('null 元素安全', () => {
    expect(() => applyHoverTitle(null, 'x')).not.toThrow()
  })
})

// ===== title HOST 契约（源码级） =====
//
// 菜单经 createPortal 仅展开时渲染、动态 title 依赖真实 hover 事件，SSR 无法覆盖，
// 故用源码断言锁定 host 归属。
describe('Dropdown — 动态 title 的 host 归属', () => {
  it('trigger：测量 .dropdown-value，但动态 title 挂在 button（e.currentTarget）上', () => {
    // 测量对象是 value span
    expect(DROPDOWN_SRC).toMatch(/overflowing:\s*isElementOverflowing\(valueRef\.current\)/)
    // 动态 title host 是 trigger button，而不是 value span
    expect(DROPDOWN_SRC).toMatch(/applyHoverTitle\(\s*e\.currentTarget,/)
    expect(DROPDOWN_SRC).not.toMatch(/applyHoverTitle\(\s*valueRef\.current,/)
    expect(DROPDOWN_SRC).not.toMatch(/valueRef\.current\.setAttribute/)
  })

  it('menu option：.dropdown-item 自身既是测量目标也是 title host', () => {
    expect(DROPDOWN_SRC).toMatch(/applyHoverTitle\(\s*e\.currentTarget,/)
    expect(DROPDOWN_SRC).toMatch(/isElementOverflowing\(e\.currentTarget\)/)
  })

  it('TEST 9b：onMouseLeave 只清理动态 fallback（description/explicit 有静态 title 时不清）', () => {
    expect(DROPDOWN_SRC).toMatch(
      /onMouseLeave=\{\(e\) => \{[\s\S]*?if \(title \|\| selected\?\.description\) return/
    )
    expect(DROPDOWN_SRC).toMatch(
      /onMouseLeave=\{\(e\) => \{[\s\S]*?if \(opt\.description\) return/
    )
  })
})

// ===== value 文本契约（截断交给 CSS） =====

describe('Dropdown — 超长 selected label', () => {
  it('value 输出完整 logical label，ellipsis CSS 生效', () => {
    const en = renderDropdown({ value: 'x', options: [{ value: 'x', label: LONG_MODEL }], onChange: () => {} })
    expect(valueText(en)).toBe(LONG_MODEL)

    const rule = cssRule('.dropdown-value')
    expect(rule).toMatch(/overflow\s*:\s*hidden/)
    expect(rule).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect(rule).toMatch(/white-space\s*:\s*nowrap/)
    expect(rule).toMatch(/min-width\s*:\s*0/)
  })
})

// ===== shrink 契约 =====

describe('Dropdown — shrink 契约', () => {
  it('root 与 trigger：可收缩且不超父容器', () => {
    for (const sel of ['.dropdown', '.dropdown-trigger']) {
      const rule = cssRule(sel)
      expect(rule).toMatch(/min-width\s*:\s*0/)
      expect(rule).toMatch(/max-width\s*:\s*100%/)
    }
  })

  it('caret 不被压缩（flex-shrink: 0）', () => {
    expect(cssRule('.dropdown-caret')).toMatch(/flex-shrink\s*:\s*0/)
  })
})

// ===== popup 几何 =====

describe('Dropdown menu 几何 — minWidth = trigger 宽度，允许更宽', () => {
  const base = {
    triggerLeft: 100,
    triggerTop: 500,
    triggerBottom: 532,
    viewportWidth: 1200,
    viewportHeight: 800,
  }

  it('TEST 1：全宽 trigger(500px) 时 minWidth = 500，绝不被任何产品级 cap 压小', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 500 })
    expect(g.minWidth).toBe(500)
    expect(g.left).toBe(100)
    // 菜单没有固定 width —— 由内容自然决定，只受 min/max 夹取
    expect(g).not.toHaveProperty('width')
    // maxWidth 只来自 viewport 安全区，不是 440 cap
    expect(g.maxWidth).toBe(1200 - 16)
  })

  it('TEST 3：viewport 只有 400px 可用时 maxWidth 限制到 viewport 安全宽度', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 220, viewportWidth: 400 })
    expect(g.maxWidth).toBe(400 - 16)
  })

  it('TEST 4：trigger 很窄(80px) 时 minWidth = 80，允许内容更宽（无 width 强制）', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 80 })
    expect(g.minWidth).toBe(80)
    expect(g).not.toHaveProperty('width')
  })

  it('TEST 5：Settings-style 全宽 trigger —— popup 不小于 trigger', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 493, viewportWidth: 1600 })
    expect(g.minWidth).toBe(493)
    // 439 是旧的 440 cap 会被压到的宽度 —— 不能再出现
    expect(g.minWidth).toBeGreaterThan(440)
  })

  it('菜单宽度不用 maxWidth 上限预留：窄菜单靠右不做提前大左移', () => {
    const g = computeMenuGeometry({ ...base, triggerLeft: 1150, triggerWidth: 220, menuWidth: 150 })
    // 1150 + 150 = 1300 > 1192 → left = 1192 - 150 = 1042
    expect(g.left).toBe(1042)
    expect(g.left).toBeGreaterThan(1200 - 8 - 440)
  })

  it('menuWidth 缺省（首帧未测量）退化为 trigger 宽度，先对齐 trigger', () => {
    const g = computeMenuGeometry({ ...base, triggerLeft: 1150, triggerWidth: 220 })
    expect(g.left).toBe(1192 - 220)
  })

  it('下方空间不足时向上翻转', () => {
    const g = computeMenuGeometry({
      triggerWidth: 200,
      triggerLeft: 100,
      triggerTop: 780,
      triggerBottom: 796,
      viewportWidth: 1200,
      viewportHeight: 800,
    })
    expect(g.bottom).toBeTypeOf('number')
    expect(g.top).toBeUndefined()
  })

  it('超长 trigger 宽于视口安全区：minWidth 被夹到 maxWidth', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 5000 })
    expect(g.minWidth).toBeLessThanOrEqual(g.maxWidth)
    expect(g.minWidth).toBe(1200 - 16)
  })

  it('CSS：菜单宽度由内容决定（width: max-content），option 超长 ellipsis', () => {
    expect(cssRule('.dropdown-menu')).toMatch(/width\s*:\s*max-content/)
    expect(cssRule('.dropdown-item')).toMatch(/text-overflow\s*:\s*ellipsis/)
  })
})

// ===== matchTriggerWidth：可选严格同宽能力 =====

describe('Dropdown matchTriggerWidth — popup 严格等于 trigger 宽度', () => {
  const base = {
    triggerLeft: 100,
    triggerTop: 500,
    triggerBottom: 532,
    viewportWidth: 1200,
    viewportHeight: 800,
  }

  it('默认 false：不设 width，minWidth 仍 = trigger，允许内容更宽', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 220 })
    expect(g).not.toHaveProperty('width')
    expect(g.minWidth).toBe(220)
    expect(g.maxWidth).toBe(1200 - 16)
  })

  it('matchTriggerWidth=true：width = minWidth = maxWidth = trigger 宽度', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 493, matchTriggerWidth: true })
    expect(g.width).toBe(493)
    expect(g.minWidth).toBe(493)
    expect(g.maxWidth).toBe(493)
  })

  it('matchTriggerWidth=true：超长 option 无法撑宽（实测 menuWidth 被忽略）', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 300, menuWidth: 5000, matchTriggerWidth: true })
    expect(g.width).toBe(300)
    expect(g.maxWidth).toBe(300)
  })

  it('matchTriggerWidth=true：水平定位按 trigger 宽度计算，不越右安全区', () => {
    const g = computeMenuGeometry({ ...base, triggerLeft: 1000, triggerWidth: 300, matchTriggerWidth: true })
    // 1000 + 300 = 1300 > 1192 → left = 1192 - 300 = 892
    expect(g.left).toBe(892)
  })

  it('matchTriggerWidth=true：viewport 极窄时宽度夹到安全区（min=max=安全宽度）', () => {
    const g = computeMenuGeometry({ ...base, triggerWidth: 5000, viewportWidth: 400, matchTriggerWidth: true })
    expect(g.width).toBe(400 - 16)
    expect(g.minWidth).toBe(g.maxWidth)
  })

  it('matchTriggerWidth=true：仍然支持向上翻转 + maxHeight', () => {
    const g = computeMenuGeometry({
      triggerWidth: 300,
      triggerLeft: 100,
      triggerTop: 780,
      triggerBottom: 796,
      viewportWidth: 1200,
      viewportHeight: 800,
      matchTriggerWidth: true,
    })
    expect(g.bottom).toBeTypeOf('number')
    expect(g.top).toBeUndefined()
    expect(g.maxHeight).toBeGreaterThan(0)
  })

  it('源码契约：computeMenuGeometry 接受 matchTriggerWidth 并锁死 min/max/width', () => {
    expect(DROPDOWN_SRC).toMatch(/matchTriggerWidth\?: boolean/)
    // 锁死块：对 geom.width/minWidth/maxWidth 都赋 minWidth
    expect(DROPDOWN_SRC).toMatch(/geom\.width = minWidth[\s\S]*?geom\.minWidth = minWidth[\s\S]*?geom\.maxWidth = minWidth/)
  })

  it('源码契约：菜单 style 使用 position.width（缺省 undefined → 不写死）', () => {
    expect(DROPDOWN_SRC).toMatch(/width:\s*position\.width,/)
  })
})

// ===== Settings 全宽表单控件启用 matchTriggerWidth，Composer 不启用 =====

describe('matchTriggerWidth 应用范围契约', () => {
  // [文件, 全宽表单控件类名] —— 这些类的 Dropdown 必须启用 matchTriggerWidth
  const FULL_WIDTH_DROPDOWNS: Array<[string, string]> = [
    ['settings/ProviderSettings.tsx', 'provider-dropdown'],
    ['settings/RequestParameterProfileEditor.tsx', 'provider-dropdown'],
    ['settings/ProxySettings.tsx', 'proxy-protocol-dropdown'],
  ]

  it('Settings 全宽表单控件 Dropdown 使用 matchTriggerWidth', () => {
    for (const [rel, cls] of FULL_WIDTH_DROPDOWNS) {
      // 去掉 JSX 注释块（如 ProviderSettings 中被注释掉的 Tools Dropdown），避免误判
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      // 每个 <Dropdown ... /> 元素 = 从 '<Dropdown' 到最近的 '/>' 之间的文本
      const segments = src.split('<Dropdown').slice(1).map((s) => s.slice(0, s.indexOf('/>')))
      const blocks = segments.filter((s) => new RegExp(`className="${cls}"`).test(s))
      expect(blocks.length).toBeGreaterThan(0)
      for (const s of blocks) {
        expect(s).toMatch(/matchTriggerWidth/)
      }
    }
  })

  it('Settings 紧凑控件（.default-model-dropdown，cap 240px）不启用 matchTriggerWidth', () => {
    const COMPACT = [
      'settings/DefaultModelSettings.tsx',
      'settings/WebSearchEngineSettings.tsx',
      'settings/ProxySettings.tsx',
    ]
    for (const rel of COMPACT) {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      const segments = src.split('<Dropdown').slice(1).map((s) => s.slice(0, s.indexOf('/>')))
      const blocks = segments.filter((s) => /className="default-model-dropdown"/.test(s))
      for (const s of blocks) {
        expect(s).not.toMatch(/matchTriggerWidth/)
      }
    }
  })

  it('Composer 的 Dropdown 一律不启用 matchTriggerWidth', () => {
    const composerDir = new URL('composer/', import.meta.url)
    for (const f of fs.readdirSync(composerDir)) {
      if (!f.endsWith('.tsx')) continue
      const src = fs.readFileSync(new URL(f, composerDir), 'utf8')
      expect(src).not.toMatch(/matchTriggerWidth/)
    }
  })
})

// ===== TEST 2：不存在共享全局产品级宽度上限 =====

describe('共享 Dropdown — 无产品级宽度上限（Settings 回归根因）', () => {
  it('TEST 2：源码不再存在 MAX_MENU_WIDTH / 440 全局 cap', () => {
    expect(DROPDOWN_SRC).not.toMatch(/MAX_MENU_WIDTH/)
    expect(DROPDOWN_SRC).not.toMatch(/\b440\b/)
  })

  it('maxWidth 仅由 viewport 安全区推导（window.innerWidth - 2*EDGE_PADDING）', () => {
    // 源码：maxWidth = viewportWidth - EDGE_PADDING * 2，无 Math.min(..., 常量)
    expect(DROPDOWN_SRC).toMatch(/maxWidth\s*=\s*Math\.max\(0,\s*viewportWidth\s*-\s*EDGE_PADDING\s*\*\s*2\)/)
  })
})

// ===== Composer 布局契约 =====

describe('Composer — send button 保护与 selector 收缩契约', () => {
  it('.composer-controls 单行不换行且可收缩', () => {
    const rule = cssRule('.composer-controls')
    expect(rule).toMatch(/flex-wrap\s*:\s*nowrap/)
    expect(rule).toMatch(/min-width\s*:\s*0/)
  })

  it('TEST 6：发送按钮不参与压缩（flex: 0 0 auto）', () => {
    expect(cssRule('.composer-controls .send-btn')).toMatch(/flex\s*:\s*0\s+0\s+auto/)
  })

  it('固定动作控件（attach / 联网开关）不被压缩', () => {
    expect(GLOBAL_CSS).toMatch(
      /\.composer-controls \.attach-btn,[\s\S]{0,80}\.composer-controls \.web-search-toggle\s*\{[^}]*flex\s*:\s*0\s+0\s+auto/
    )
  })

  // ── sizing policy：content-sized selector，只设 max-width 上限（异常文本安全网） ──
  const MAX_CAPS: Array<[string, number]> = [
    ['.composer-controls .model-selector', 220],
    ['.composer-controls .provider-selector', 180],
    ['.composer-controls .reasoning-selector', 160],
  ]

  it('TEST 6：selector 只设 max-width 上限，不设固定 width / flex-basis（保持 content-sized）', () => {
    for (const [sel, cap] of MAX_CAPS) {
      const rule = cssRule(sel)
      expect(rule).toMatch(new RegExp(`max-width\\s*:\\s*${cap}px`))
      expect(rule).toMatch(/flex-shrink\s*:\s*1/)
      // 不再有固定宽度：无 width:<n>px、无 flex:0 1 <n>px
      expect(rule).not.toMatch(/(^|[^-])width\s*:/)
      expect(rule).not.toMatch(/flex\s*:\s*0\s+1\s+\d+px/)
      expect(rule).not.toMatch(/flex-basis\s*:/)
    }
  })

  it('search-engine-selector 完全 content-sized：无任何宽度约束规则', () => {
    expect(GLOBAL_CSS).not.toMatch(/\.composer-controls \.search-engine-selector\s*\{/)
  })

  it('仍可 shrink：基类 .dropdown / .dropdown-trigger / .dropdown-value min-width:0', () => {
    expect(cssRule('.dropdown')).toMatch(/min-width\s*:\s*0/)
    expect(cssRule('.dropdown-trigger')).toMatch(/min-width\s*:\s*0/)
    expect(cssRule('.dropdown-value')).toMatch(/min-width\s*:\s*0/)
  })

  it('popup：默认 minWidth = trigger 宽度，不写死 width（源码契约）', () => {
    expect(DROPDOWN_SRC).toMatch(/triggerWidth:\s*rect\.width/)
    expect(DROPDOWN_SRC).toMatch(/minWidth:\s*position\.minWidth/)
    // 默认路径不写死 width；width: position.width 仅由 matchTriggerWidth 产生
    expect(DROPDOWN_SRC).toMatch(/width:\s*position\.width,/)
    expect(DROPDOWN_SRC).toMatch(/maxWidth:\s*position\.maxWidth/)
  })

  it('所有自动 sizing 实验代码已彻底删除', () => {
    // Dropdown 源码：无 sizeToOptions / 测量 / 依赖键 / 测量 DOM
    expect(DROPDOWN_SRC).not.toMatch(/sizeToOptions/)
    expect(DROPDOWN_SRC).not.toMatch(/measureWidest|optionLabelsKey|measuredWidth/)
    expect(DROPDOWN_SRC).not.toMatch(/dropdown-measure-container|dropdown-trigger-measure/)
    // 允许 useLayoutEffect 测量「已渲染菜单」用于定位，但绝不允许测量 label/options
    expect(DROPDOWN_SRC).not.toMatch(/querySelectorAll/)
    expect(DROPDOWN_SRC).not.toMatch(/measureText/)
    // CSS：无 probe / 测量容器 / grid sizing
    expect(GLOBAL_CSS).not.toMatch(/dropdown-sizer/)
    expect(GLOBAL_CSS).not.toMatch(/dropdown-measure-container|dropdown-trigger-measure/)
    expect(GLOBAL_CSS).not.toMatch(/size-to-options/)
  })

  it('trigger 恢复 content-sized：不设 width:100%（不填满根节点）', () => {
    expect(cssRule('.dropdown-trigger')).not.toMatch(/(^|[^-])width\s*:\s*100%/)
    expect(cssRule('.dropdown-trigger')).toMatch(/min-width\s*:\s*0/)
  })
})
