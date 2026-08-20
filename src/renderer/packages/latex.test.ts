import { describe, it, expect } from 'vitest'
import { processLaTeX } from './latex'

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
})