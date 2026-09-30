/**
 * 加粗 `**` flanking 兼容性测试（AST / 渲染层）
 *
 * LLM 常生成「正文**「引号」**」这类写法：开 / 闭 `**` 紧邻标点，
 * 会被 CommonMark 判为 not-left / right-flanking → 加粗失效、`**` 原样外泄。
 *
 * 本测试走 OpenChat 真实链路（processLaTeX → unified → HAST → React），
 * 并对照「未经 processLaTeX 的 raw micromark」结果，断言：
 *   1. raw 会失败的写法，经 normalization 后能渲染出 <strong>；
 *   2. sentinel（U+FDD0）不得泄漏到最终 HTML / 文本；
 *   3. 复制语义：渲染文本 == 原文去掉 **，不多不少、无隐藏字符；
 *   4. 代码 / 转义 / 更长 delimiter run / emoji / 合法 Markdown 不回归。
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import type { Components } from 'react-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import type { Root as HastRoot } from 'hast'
import { compileMarkdownToHast } from './markdownCompiler'
import { renderHastToReact } from './markdownHastRenderer'
import { KATEX_OPTIONS } from './katexOptions'
import { BOLD_SENTINEL } from './latex'

const components: Components = {}

/** 生产链路：processLaTeX → unified → HAST → React → HTML */
function renderHtml(content: string): string {
  const hast = compileMarkdownToHast(content)
  const element = renderHastToReact(hast, components)
  const wrapper = React.createElement('div', { className: 'markdown-body' }, element)
  return ReactDOMServer.renderToStaticMarkup(wrapper)
}

/** 对照组：跳过 processLaTeX，直接以原始 micromark/CommonMark 解析 */
const rawProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeKatex, KATEX_OPTIONS as any)

function renderHtmlRaw(content: string): string {
  const mdast = rawProcessor.parse(content)
  const hast = rawProcessor.runSync(mdast, content) as HastRoot
  const element = renderHastToReact(hast, components)
  const wrapper = React.createElement('div', { className: 'markdown-body' }, element)
  return ReactDOMServer.renderToStaticMarkup(wrapper)
}

/** 粗粒度取渲染后纯文本（测试用例均为纯段落，无实体转义） */
function textContent(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
}

// ===== 1. raw 会失败、normalization 后必须成功的写法 =====
const fixedByNormalization: string[] = [
  '这是**「普通文本」**',
  '这是**"普通文本"**',
  '这是**（普通文本）**',
  '这是**“普通文本”**',
  '这是**(普通文本)**',
  '前文**《书名号》**后文',
  '前文**【方括号】**后文',
  '剧中狄仁杰真正说的是类似的**「依你之见呢？」「说说你的想法」**',
]

describe('bold flanking: raw fails, normalized succeeds', () => {
  for (const content of fixedByNormalization) {
    it(`normalizes: ${JSON.stringify(content)}`, () => {
      const rawHtml = renderHtmlRaw(content)
      const html = renderHtml(content)
      // 原始 CommonMark 判定为字面量（文档化 bug 触发条件）
      expect(rawHtml).not.toContain('<strong>')
      // normalization 后必须加粗
      expect(html).toContain('<strong>')
      // 且不得泄漏字面量 ** 或 sentinel
      expect(html).not.toContain('**')
      expect(html).not.toContain(BOLD_SENTINEL)
    })
  }
})

// ===== 2. 需要兼容的空格 / 行首写法（raw 即成功）=====
const shouldBold: string[] = [
  '普通**粗体**',
  '普通 **粗体**',
  '普通**「粗体」**',
  '普通**“粗体”**',
  '普通**（粗体）**',
  '普通**《粗体》**',
  '普通**【粗体】**',
  '普通**(粗体)**',
  '普通**"粗体"**',
  '**「行首粗体」**',
  '前文 **「中文引号」** 后文',
]

describe('bold flanking: should render <strong>', () => {
  for (const content of shouldBold) {
    it(`renders bold: ${JSON.stringify(content)}`, () => {
      const html = renderHtml(content)
      expect(html).toContain('<strong>')
      expect(html).not.toContain('**')
      expect(html).not.toContain(BOLD_SENTINEL)
    })
  }

  it('renders bold around link text', () => {
    const html = renderHtml('前文**[Markdown link](https://example.com)**后文')
    expect(html).toContain('<strong>')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain('**')
    expect(html).not.toContain(BOLD_SENTINEL)
  })

  it('renders bold around inline code', () => {
    const html = renderHtml('前文**`code`**后文')
    expect(html).toContain('<strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).not.toContain(BOLD_SENTINEL)
  })
})

// ===== 3. Emoji / Unicode Symbol =====
// micromark 的 context.previous/next 是单个 UTF-16 code unit：
//   - 非 BMP emoji（🔥=U+1F525，代理对）→ 代理项分类为 ordinary → 不影响 flanking；
//   - BMP 符号 emoji（⭐=U+2B50, ✅=U+2705, ⚠=U+26A0, ❤=U+2764, 均 So）→ 分类为
//     punctuation → 与「正文」相邻时使起始 ** not-left-flanking，需修复。
describe('bold flanking: emoji / unicode symbol (raw already works)', () => {
  const rawOk: string[] = [
    '中文**🔥重点**',
    '中文 **🔥重点**',
    '**🔥重点**',
    '中文**🔥重点**后文',
  ]
  for (const content of rawOk) {
    it(`raw + normalized both bold: ${JSON.stringify(content)}`, () => {
      expect(renderHtmlRaw(content)).toContain('<strong>')
      const html = renderHtml(content)
      expect(html).toContain('<strong>')
      expect(html).not.toContain('**')
      expect(html).not.toContain(BOLD_SENTINEL)
    })
  }
})

describe('bold flanking: emoji / unicode symbol (needs normalization)', () => {
  const fixed: string[] = [
    '中文**⭐重点**',
    '中文**✅重点**',
    '中文**⚠️重点**',
    '中文**❤️重点**',
  ]
  for (const content of fixed) {
    it(`raw fails, normalized bolds: ${JSON.stringify(content)}`, () => {
      expect(renderHtmlRaw(content)).not.toContain('<strong>')
      const html = renderHtml(content)
      expect(html).toContain('<strong>')
      expect(html).not.toContain('**')
      expect(html).not.toContain(BOLD_SENTINEL)
    })
  }
})

// ===== 4. 无泄漏：<strong> 的 textContent 必须精确 =====
describe('bold flanking: sentinel must not leak into DOM', () => {
  // 断言对象是浏览器文本语义（textContent），而非 SSR 序列化 HTML：
  // React SSR 会把 `"` 转义成 `&quot;`，因此这里直接比对去标签后的纯文本，
  // 避免把「实体转义」误判为泄漏。
  const exactText: Array<[string, string]> = [
    ['这是**「重点」**', '这是「重点」'],
    ['这是**“重点”**', '这是“重点”'],
    ['这是**（重点）**', '这是（重点）'],
    ['这是**《重点》**', '这是《重点》'],
    ['这是**【重点】**', '这是【重点】'],
    ['这是**"重点"**', '这是"重点"'],
  ]

  for (const [input, expectedText] of exactText) {
    it(`<strong> textContent is exact for ${JSON.stringify(input)}`, () => {
      const html = renderHtml(input)
      expect(html).toContain('<strong>')
      // 文本语义精确（无 sentinel、无 ZWSP、实体已还原）
      expect(textContent(html)).toBe(expectedText)
      expect(html).not.toContain(BOLD_SENTINEL)
      expect(html).not.toContain('\u200B')
      // strong 内不得出现任何隐藏字符
      const inner = /<strong>([\s\S]*?)<\/strong>/.exec(html)?.[1] ?? ''
      expect(inner).not.toContain(BOLD_SENTINEL)
      expect(inner).not.toContain('\u200B')
    })
  }
})

// ===== 5. 复制语义：渲染文本 == 原文去掉 ** =====
describe('bold flanking: copy semantics', () => {
  it('produces exact textContent for the 狄仁杰 quote case', () => {
    const input = '剧中真正说的是类似的**「依你之见呢？」「说说你的想法」**。所以……'
    const expected = '剧中真正说的是类似的「依你之见呢？」「说说你的想法」。所以……'
    const html = renderHtml(input)
    expect(html).toContain('<strong>')
    expect(textContent(html)).toBe(expected)
    expect(textContent(html)).not.toContain(BOLD_SENTINEL)
    expect(textContent(html)).not.toContain('\u200B')
    expect(textContent(html)).not.toContain('**')
  })

  it('keeps a normal (non-fixed) message byte-identical in textContent', () => {
    const input = '普通**粗体**和普通文本'
    const html = renderHtml(input)
    expect(textContent(html)).toBe('普通粗体和普通文本')
    expect(textContent(html)).not.toContain(BOLD_SENTINEL)
    expect(textContent(html)).not.toContain('\u200B')
  })
})

// ===== 6. 不允许被错误修改 =====
describe('bold flanking: must not over-reach', () => {
  it('keeps escaped ** as literal', () => {
    const html = renderHtml('\\*\\*这只是 Markdown 示例\\*\\*')
    expect(html).not.toContain('<strong>')
    expect(html).toContain('**这只是 Markdown 示例**')
    expect(html).not.toContain(BOLD_SENTINEL)
  })

  it('does not touch ** inside inline code', () => {
    const html = renderHtml('`**not bold**`')
    expect(html).not.toContain('<strong>')
    expect(html).toContain('**not bold**')
    expect(html).not.toContain(BOLD_SENTINEL)
  })

  it('does not touch ** inside fenced code block (ASCII)', () => {
    const html = renderHtml('```md\n**not bold**\n```')
    expect(html).not.toContain('<strong>')
    expect(html).toContain('**not bold**')
  })

  it('does not touch ** inside fenced code block (CJK punctuation)', () => {
    const html = renderHtml('```md\n这是**「x」**\n```')
    expect(html).not.toContain('<strong>')
    expect(html).toContain('这是**「x」**')
    expect(html).not.toContain(BOLD_SENTINEL)
  })

  it('preserves user-authored U+200B (only our sentinel is stripped)', () => {
    const input = '这里有\u200B零宽空格，还有**「粗体」**'
    const html = renderHtml(input)
    expect(textContent(html)).toBe('这里有\u200B零宽空格，还有「粗体」')
    expect(textContent(html)).toContain('\u200B')
    expect(html).not.toContain(BOLD_SENTINEL)
  })

  it('does not regress ordinary strong / emphasis / strike / link', () => {
    const html = renderHtml('**bold** and ***bold italic*** and ~~delete~~ and [link](https://example.com)')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<del>delete</del>')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain(BOLD_SENTINEL)
  })

  it('does not alter *** triple runs', () => {
    const html = renderHtml('正文***粗斜体***尾')
    expect(html).toContain('<strong>')
    expect(html).toContain('<em>')
    expect(html).not.toContain(BOLD_SENTINEL)
  })
})

// ===== 7. sentinel 自身分类前提（防止未来替换成会改变分类的字符）=====
describe('bold sentinel classification preconditions', () => {
  it('is neither whitespace nor punctuation by classifiers used by micromark', () => {
    expect(/\s/.test(BOLD_SENTINEL)).toBe(false)
    expect(/[\p{P}\p{S}]/u.test(BOLD_SENTINEL)).toBe(false)
  })
})
