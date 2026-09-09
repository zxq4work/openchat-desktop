/**
 * Markdown HAST 渲染等价性测试
 *
 * 对比 react-markdown（原始路径）与 compileMarkdownToHast + renderHastToReact（缓存路径）
 * 的输出，确保 DOM 结构完全一致。
 *
 * 使用 byte-level HTML 比较，仅对确认无语义的 SSR 属性差异做最小 normalize。
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import rehypeKatex from 'rehype-katex'
import { processLaTeX } from './latex'
import { compileMarkdownToHast } from './markdownCompiler'
import { renderHastToReact } from './markdownHastRenderer'
import { KATEX_OPTIONS } from './katexOptions'

// 与 MarkdownRenderer 完全一致的 components
function extractTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractTextContent).join('')
  if (React.isValidElement(node)) {
    return extractTextContent((node.props as any).children)
  }
  return ''
}

function CodeRenderer({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'>) {
  return <code className={className} {...props}>{children}</code>
}

function CopyButton({ code }: { code: string }) {
  return <button className="code-copy-button" title="复制代码">copy</button>
}

function PreRenderer({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) {
  const codeElement = React.Children.only(children) as React.ReactElement
  const className = (codeElement.props as any).className || ''
  const language = className.replace('language-', '')
  const codeText = extractTextContent((codeElement.props as any).children)

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-language">{language}</span>
        <CopyButton code={codeText} />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  )
}

function LinkRenderer({ href, children, ...props }: React.ComponentPropsWithoutRef<'a'>) {
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
}

const components: Components = {
  code: CodeRenderer,
  pre: PreRenderer,
  a: LinkRenderer,
}

/**
 * 用 react-markdown 渲染并返回 HTML string
 */
function renderWithReactMarkdown(content: string): string {
  const processed = processLaTeX(content)
  const element = React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath, remarkBreaks],
    rehypePlugins: [[rehypeKatex, KATEX_OPTIONS]],
    components,
    children: processed,
  })
  const wrapper = React.createElement('div', { className: 'markdown-body' }, element)
  return ReactDOMServer.renderToStaticMarkup(wrapper)
}

/**
 * 用 HAST 路径渲染并返回 HTML string
 */
function renderWithHast(content: string): string {
  const hast = compileMarkdownToHast(content)
  const reactElement = renderHastToReact(hast, components)
  const wrapper = React.createElement('div', { className: 'markdown-body' }, reactElement)
  return ReactDOMServer.renderToStaticMarkup(wrapper)
}

/**
 * 最小 normalize：仅移除 React SSR 自动生成且确认无语义的属性。
 * 不做 whitespace collapse —— <pre>/<code> 中的空白具有语义。
 */
function normalizeHtml(html: string): string {
  return html
    // 移除 data-reactroot 属性（React SSR 自动生成，两端行为一致但值可能不同）
    .replace(/ data-reactroot="[^"]*"/g, '')
}

// ===== 测试用例 =====

const fixtures: Array<{ name: string; content: string }> = [
  // --- 基础 Markdown ---
  {
    name: 'paragraph',
    content: 'Hello world',
  },
  {
    name: 'heading',
    content: '# Title\n## Subtitle',
  },
  {
    name: 'bold and italic',
    content: '**bold** and *italic* and ***both***',
  },

  // --- GFM ---
  {
    name: 'GFM table',
    content: '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
  },
  {
    name: 'task list',
    content: '- [x] done\n- [ ] todo',
  },
  {
    name: 'strikethrough',
    content: '~~deleted~~ text',
  },
  {
    name: 'autolink',
    content: 'Visit <https://example.com> for info.',
  },

  // --- Code ---
  {
    name: 'fenced code',
    content: '```js\nconst x = 1;\nconsole.log(x);\n```',
  },
  {
    name: 'inline code',
    content: 'Use `console.log` to debug.',
  },
  {
    name: 'code with dollar sign',
    content: '```\n$variable = 100\n$other = 200\n```',
  },
  {
    name: 'inline code with dollar',
    content: 'Use `$HOME` environment variable.',
  },

  // --- Code whitespace preservation ---
  {
    name: 'multi-line code with indentation',
    content: '```js\nfunction test() {\n    const x = 1;\n\n    console.log(x);\n}\n```',
  },
  {
    name: 'Python indentation-dependent code',
    content: '```python\nif True:\n    print("a")\n    if False:\n        print("b")\n```',
  },
  {
    name: 'code block with blank lines and spaces',
    content: '```\nline1\n\n   indented\n\nline2\n```',
  },
  {
    name: 'code block with $ characters in strings',
    content: '```bash\necho "cost is $10"\necho "total: $25"\n```',
  },

  // --- Links & Security ---
  {
    name: 'normal link',
    content: '[OpenAI](https://openai.com)',
  },
  {
    name: 'unsafe javascript: link',
    content: '[click](javascript:alert(1))',
  },
  {
    name: 'image URL',
    content: '![alt](https://example.com/image.png)',
  },

  // --- Line breaks ---
  {
    name: 'line breaks (remark-breaks)',
    content: 'line1\nline2\nline3',
  },
  {
    name: 'consecutive blank lines',
    content: 'para1\n\n\npara2',
  },

  // --- Math ---
  {
    name: 'inline math',
    content: 'The result is $x + y$ and $z$.',
  },
  {
    name: 'block math',
    content: '$$\n\\frac{a}{b} + \\sqrt{c} = \\sum_{i=1}^{n} x_i\n$$',
  },
  {
    name: 'frac and sqrt',
    content: '$\\frac{1}{2}$ and $\\sqrt{x^2 + y^2}$',
  },
  {
    name: 'malformed math',
    content: '$\\invalid{command}$ and $\\frac{}{}$',
  },
  {
    name: 'block LaTeX delimiters',
    content: 'Formula: \\[x^2 + y^2 = z^2\\] and inline \\(a+b\\)',
  },

  // --- CJK ---
  {
    name: 'Chinese/CJK',
    content: '这是一段中文文字。**加粗**和*斜体*。\n\n第二段落。',
  },
  {
    name: 'CJK bold fix',
    content: '**Judith Grimes（茱蒂丝·格莱姆斯）**是美剧',
  },

  // --- Raw HTML ---
  {
    name: 'raw HTML (b tag)',
    content: 'Before <b>bold</b> after',
  },

  // --- Mixed ---
  {
    name: 'mixed: table + math + code',
    content: '## Results\n\n| Formula | Value |\n| --- | --- |\n| $\\pi$ | 3.14 |\n| $e$ | 2.72 |\n\n```python\nimport math\nprint(math.pi)\n```\n\nInline: $\\frac{1}{2}$',
  },
]

describe('Markdown HAST parity', () => {
  for (const fixture of fixtures) {
    it(`renders "${fixture.name}" identically`, () => {
      const reactMarkdownHtml = renderWithReactMarkdown(fixture.content)
      const hastHtml = renderWithHast(fixture.content)
      expect(normalizeHtml(hastHtml)).toBe(normalizeHtml(reactMarkdownHtml))
    })
  }
})
