import { describe, it, expect } from 'vitest'
import { processLaTeX, BOLD_SENTINEL } from './latex'

describe('processLaTeX', () => {
  // Case 1: 块级公式 \[...\]
  it('converts block LaTeX delimiters to $$', () => {
    const input = '\\[\nx^2 + y^2 = z^2\n\\]'
    const result = processLaTeX(input)
    expect(result).toBe('\n$$\nx^2 + y^2 = z^2\n$$\n')
    expect(result).not.toContain('\\[')
    expect(result).not.toContain('\\]')
  })

  // Case 2: 行内公式 \(...\)
  it('converts inline LaTeX delimiters to $', () => {
    const input = '这是 \\(x+y\\) 的结果'
    const result = processLaTeX(input)
    expect(result).toBe('这是 $x+y$ 的结果')
  })

  // Case 3: 已有块级 $$...$$
  it('keeps existing $$ block delimiters unchanged', () => {
    const input = '$$\nx+y\n$$'
    const result = processLaTeX(input)
    expect(result).toBe('$$\nx+y\n$$')
  })

  // Case 4: 已有行内 $...$
  it('keeps existing $ inline delimiters unchanged', () => {
    const input = '$x+y$'
    const result = processLaTeX(input)
    expect(result).toBe('$x+y$')
  })

  // Case 5: fenced code block 中的定界符原样保留
  it('preserves LaTeX delimiters inside fenced code blocks', () => {
    const input = '```\n\\[\nx+y\n\\]\n```'
    const result = processLaTeX(input)
    expect(result).toBe('```\n\\[\nx+y\n\\]\n```')
    expect(result).not.toContain('$$')
  })

  // Case 5b: tilde fenced code block
  it('preserves LaTeX delimiters inside tilde fenced code blocks', () => {
    const input = '~~~\n\\(x+y\\)\n~~~'
    const result = processLaTeX(input)
    expect(result).toBe('~~~\n\\(x+y\\)\n~~~')
    expect(result).not.toContain('$x+y$')
  })

  // Case 6: inline code 中的定界符原样保留
  it('preserves LaTeX delimiters inside inline code', () => {
    const input = '`\\[x+y\\]`'
    const result = processLaTeX(input)
    expect(result).toBe('`\\[x+y\\]`')
  })

  // Case 7: 未闭合块公式（流式场景）
  it('keeps unclosed block delimiter unchanged for streaming', () => {
    const input = '\\[\nx+y'
    const result = processLaTeX(input)
    expect(result).toBe('\\[\nx+y')
  })

  // Case 8: 未闭合行内公式（流式场景）
  it('keeps unclosed inline delimiter unchanged for streaming', () => {
    const input = '\\(x+y'
    const result = processLaTeX(input)
    expect(result).toBe('\\(x+y')
  })

  // Case 9: 混合公式
  it('handles mixed block and inline formulas', () => {
    const input = '文字\n\n\\[\na+b=c\n\\]\n\n继续文字 \\(x+y\\)。'
    const result = processLaTeX(input)
    expect(result).toBe('文字\n\n\n$$\na+b=c\n$$\n\n\n继续文字 $x+y$。')
  })

  // Case 10: 词向量实际案例
  it('converts word vector example correctly', () => {
    const input = '\\[\n\\vec{\\text{king}}-\\vec{\\text{man}}+\\vec{\\text{woman}}\n\\approx\n\\vec{\\text{queen}}\n\\]'
    const result = processLaTeX(input)
    expect(result).toContain('$$\n')
    expect(result).toContain('\n$$')
    expect(result).not.toContain('\\[')
    expect(result).not.toContain('\\]')
    expect(result).toContain('\\vec{\\text{king}}')
  })

  // Case 11: 第二个词向量案例
  it('converts second word vector example correctly', () => {
    const input = '\\[\n\\vec{\\text{Paris}}-\\vec{\\text{France}}+\\vec{\\text{Italy}}\n\\approx\n\\vec{\\text{Rome}}\n\\]'
    const result = processLaTeX(input)
    expect(result).toContain('$$\n')
    expect(result).toContain('\n$$')
    expect(result).not.toContain('\\[')
    expect(result).not.toContain('\\]')
  })

  // Case 12: 普通方括号不受影响
  it('does not modify plain brackets', () => {
    const input = '[hello]'
    const result = processLaTeX(input)
    expect(result).toBe('[hello]')
  })

  // Case 13: 代码块中展示 LaTeX 源码
  it('preserves LaTeX source in code blocks', () => {
    const input = '下面展示 LaTeX 源码：\n\n```\n\\[\n\\vec{x}\n\\]\n```\n\n上面是代码块。'
    const result = processLaTeX(input)
    expect(result).toContain('```\n\\[\n\\vec{x}\n\\]\n```')
  })

  // 空字符串
  it('handles empty string', () => {
    expect(processLaTeX('')).toBe('')
  })

  // 边界：只有打开定界符，没有内容
  it('handles opener with no content before closer', () => {
    const input = '\\[\\]'
    const result = processLaTeX(input)
    expect(result).toBe('\n$$\n\n$$\n')
  })

  // 嵌套：正常文本中 $ 和 \[ 共存
  it('handles mixed $ and \\[ in same text', () => {
    const input = '成本是 $10 到 $20，公式：\\[x+y\\]'
    const result = processLaTeX(input)
    expect(result).toBe('成本是 $10 到 $20，公式：\n$$\nx+y\n$$\n')
  })

  // Case 14: 闭合 ** 紧邻全角标点、后接正文 → 在 ** 前插入 sentinel 修复
  it('inserts sentinel before closing ** preceded by CJK punctuation', () => {
    const input = '**Judith Grimes（茱蒂丝·格莱姆斯）**是美剧'
    const result = processLaTeX(input)
    expect(result).toBe(`**Judith Grimes（茱蒂丝·格莱姆斯）${BOLD_SENTINEL}**是美剧`)
  })

  // ===== 加粗 flanking 修复：起始 ** 前是普通字符、后紧跟标点（在 ** 后插 sentinel）=====
  it('fixes opening ** preceded by CJK text and followed by punctuation', () => {
    expect(processLaTeX('这是**「普通文本」**')).toBe(`这是**${BOLD_SENTINEL}「普通文本」**`)
    expect(processLaTeX('这是**"普通文本"**')).toBe(`这是**${BOLD_SENTINEL}"普通文本"**`)
    expect(processLaTeX('这是**（普通文本）**')).toBe(`这是**${BOLD_SENTINEL}（普通文本）**`)
    expect(processLaTeX('这是**“普通文本”**')).toBe(`这是**${BOLD_SENTINEL}“普通文本”**`)
    expect(processLaTeX('这是**(普通文本)**')).toBe(`这是**${BOLD_SENTINEL}(普通文本)**`)
  })

  it('fixes opening ** around CJK/English bracket book titles and links', () => {
    // 起始 ** 后插 sentinel；闭合 ** 因后面紧跟普通文字，前也插 sentinel
    expect(processLaTeX('前文**《书名号》**后文')).toBe(`前文**${BOLD_SENTINEL}《书名号》${BOLD_SENTINEL}**后文`)
    expect(processLaTeX('前文**【方括号】**后文')).toBe(`前文**${BOLD_SENTINEL}【方括号】${BOLD_SENTINEL}**后文`)
    expect(processLaTeX('前文**[Markdown link](https://example.com)**后文')).toBe(
      `前文**${BOLD_SENTINEL}[Markdown link](https://example.com)${BOLD_SENTINEL}**后文`
    )
  })

  // ===== 闭合 ** 需要修复：前是标点、后是普通字符（在 ** 前插 sentinel）=====
  it('fixes closing ** preceded by punctuation and followed by CJK text', () => {
    expect(processLaTeX('**普通文本。**后续')).toBe(`**普通文本。${BOLD_SENTINEL}**后续`)
    expect(processLaTeX('**（引号）**后续')).toBe(`**（引号）${BOLD_SENTINEL}**后续`)
  })

  it('does not alter ** already preceded by whitespace or at line start', () => {
    expect(processLaTeX('这是 **「普通文本」**')).toBe('这是 **「普通文本」**')
    expect(processLaTeX('**「行首文本」**')).toBe('**「行首文本」**')
    expect(processLaTeX('**「元芳，你怎么看？」**\n')).toBe('**「元芳，你怎么看？」**\n')
  })

  it('does not alter ** followed by a normal (non-punctuation) character', () => {
    expect(processLaTeX('这是**普通文本**')).toBe('这是**普通文本**')
    expect(processLaTeX('这是**bold**')).toBe('这是**bold**')
  })

  it('does not touch ** inside inline code or fenced code blocks', () => {
    expect(processLaTeX('`**not bold**`')).toBe('`**not bold**`')
    expect(processLaTeX('`这是**「x」**`')).toBe('`这是**「x」**`')
    expect(processLaTeX('```md\n这是**「x」**\n```')).toBe('```md\n这是**「x」**\n```')
  })

  it('leaves longer delimiter runs (*** / ****) untouched', () => {
    expect(processLaTeX('正文***bold italic***')).toBe('正文***bold italic***')
  })

  it('does not touch escaped \\*\\* literals', () => {
    expect(processLaTeX('正文\\*\\*「x」\\*\\*')).toBe('正文\\*\\*「x」\\*\\*')
  })

  // 实际案例：中文正文后紧跟带引号的粗体；行尾闭合 ** 后无字符 → 天然可闭合
  it('fixes the real-world 狄仁杰 case', () => {
    const input = '剧中狄仁杰真正说的是类似的**「依你之见呢？」「说说你的想法」**'
    const result = processLaTeX(input)
    expect(result).toContain(`类似的**${BOLD_SENTINEL}「依你之见呢？」「说说你的想法」**`)
  })

  // 数字相邻普通字符后的起始 **
  it('fixes opening ** after digits', () => {
    expect(processLaTeX('123**「x」**')).toBe(`123**${BOLD_SENTINEL}「x」**`)
  })

  // 非 BMP emoji（😀 = U+1F600）以两个 code unit 参与 tokenize；紧跟其后的
  // 「起始 **」prev 是低代理项（分类为 ordinary），后接标点 → 起始需修复；
  // 「闭合 **」前是标点、后接正文 → 闭合也需修复。
  it('fixes both delimiters for astral emoji before punctuation', () => {
    expect(processLaTeX('😀**「x」**后')).toBe(`😀**${BOLD_SENTINEL}「x」${BOLD_SENTINEL}**后`)
  })

  // astral emoji 出现在 ** 之后（next 侧）时，其高代理项分类为 ordinary，
  // 起始 ** 天然可打开，无需修复。
  it('does not insert sentinel when astral emoji follows opening **', () => {
    expect(processLaTeX('中文**🔥重点**')).toBe('中文**🔥重点**')
  })

  // BMP 符号类 emoji（⭐ = U+2B50, So）紧跟 ** 时是标点 → 需修复起始 **。
  it('fixes opening ** before BMP symbol emoji', () => {
    expect(processLaTeX('中文**⭐重点**')).toBe(`中文**${BOLD_SENTINEL}⭐重点**`)
  })

  // ===== 回归测试：无 delimiter 的 LaTeX 命令（processLaTeX 应原样保留） =====

  it('preserves \\lfloor without explicit delimiters', () => {
    const input = '\\lfloor13(m+1)/5\\rfloor\\\\'
    const result = processLaTeX(input)
    expect(result).toBe('\\lfloor13(m+1)/5\\rfloor\\\\')
  })

  it('preserves \\lfloor K/4 \\rfloor', () => {
    const input = '\\lfloor K/4 \\rfloor\\\\'
    const result = processLaTeX(input)
    expect(result).toBe('\\lfloor K/4 \\rfloor\\\\')
  })

  it('preserves \\lfloor J/4 \\rfloor', () => {
    const input = '\\lfloor J/4 \\rfloor\\\\'
    const result = processLaTeX(input)
    expect(result).toBe('\\lfloor J/4 \\rfloor\\\\')
  })

  it('preserves -2J without delimiters', () => {
    const input = '-2J\\\\'
    const result = processLaTeX(input)
    expect(result).toBe('-2J\\\\')
  })

  it('preserves \\sqrt{x} without delimiters', () => {
    const input = '\\sqrt{x}'
    const result = processLaTeX(input)
    expect(result).toBe('\\sqrt{x}')
  })

  it('preserves $x$ inline math', () => {
    const input = '$x$'
    const result = processLaTeX(input)
    expect(result).toBe('$x$')
  })

  it('preserves $x+y$ inline math', () => {
    const input = '$x+y$'
    const result = processLaTeX(input)
    expect(result).toBe('$x+y$')
  })

  it('preserves $\\frac{1}{2}$ inline math', () => {
    const input = '$\\frac{1}{2}$'
    const result = processLaTeX(input)
    expect(result).toBe('$\\frac{1}{2}$')
  })

  it('preserves $\\text{中文}$ inline math', () => {
    const input = '$\\text{中文}$'
    const result = processLaTeX(input)
    expect(result).toBe('$\\text{中文}$')
  })

  it('converts \\[x^2+y^2\\] to $$ block', () => {
    const input = '\\[x^2+y^2\\]'
    const result = processLaTeX(input)
    expect(result).toBe('\n$$\nx^2+y^2\n$$\n')
  })

  it('preserves LaTeX inside code blocks', () => {
    const input = '```\n\\lfloor13(m+1)/5\\rfloor\n```'
    const result = processLaTeX(input)
    expect(result).toBe('```\n\\lfloor13(m+1)/5\\rfloor\n```')
  })

  it('preserves Chinese markdown table with mixed math', () => {
    const input = '| 名称 | 公式 |\n| --- | --- |\n| 求和 | $\\sum_{i=1}^{n} x_i$ |\n| 分数 | $\\frac{a}{b}$ |'
    const result = processLaTeX(input)
    expect(result).toContain('$\\sum_{i=1}^{n} x_i$')
    expect(result).toContain('$\\frac{a}{b}$')
    expect(result).toContain('| 名称 | 公式 |')
  })

  it('does not escape $中文$ as LaTeX math when CJK only', () => {
    // processLaTeX 本身不处理 $ 语义，$中文$ 会原样保留
    // 由 remark-math 决定是否渲染为数学公式，但 processLaTeX 不应修改
    const input = '$星期四$'
    const result = processLaTeX(input)
    expect(result).toBe('$星期四$')
  })
})