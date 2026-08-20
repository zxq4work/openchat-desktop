/**
 * LaTeX 定界符标准化预处理。
 *
 * 支持四种定界符：
 *   $...$   → 保持不变
 *   $$...$$ → 保持不变
 *   \(...\) → $...$（行内）
 *   \[...\] → $$...$$（块级）
 *
 * 只在 TEXT 状态进行转换；
 * 代码区域（围栏 / 行内代码）中的反斜杠定界符原样保留。
 *
 * 流式输出兼容：未闭合的 \( 或 \[ 保持原文不变。
 */

type ScanState = 'TEXT' | 'INLINE_CODE' | 'FENCED_CODE_BACKTICK' | 'FENCED_CODE_TILDE'

// 在 TEXT 状态中向前查找闭合定界符，忽略代码区域内的匹配
// 返回闭合位置索引，-1 表示未找到
function findClosingDelim(text: string, startPos: number, open: string, close: string): number {
  let state: ScanState = 'TEXT'
  let i = startPos

  while (i < text.length) {
    if (state === 'TEXT') {
      // 检查围栏开始
      if (text.startsWith('```', i)) {
        state = 'FENCED_CODE_BACKTICK'
        i += 3
        continue
      }
      if (text.startsWith('~~~', i)) {
        state = 'FENCED_CODE_TILDE'
        i += 3
        continue
      }
      // 检查行内代码
      if (text[i] === '`') {
        state = 'INLINE_CODE'
        i += 1
        continue
      }
      // 检查闭合定界符
      if (text.startsWith(close, i)) {
        return i
      }
      i += 1
    } else if (state === 'INLINE_CODE') {
      if (text[i] === '`') {
        state = 'TEXT'
      }
      i += 1
    } else if (state === 'FENCED_CODE_BACKTICK') {
      if (text.startsWith('```', i)) {
        state = 'TEXT'
        i += 3
        continue
      }
      i += 1
    } else if (state === 'FENCED_CODE_TILDE') {
      if (text.startsWith('~~~', i)) {
        state = 'TEXT'
        i += 3
        continue
      }
      i += 1
    }
  }

  return -1
}

export function processLaTeX(markdown: string): string {
  if (!markdown) return ''

  // CommonMark 规范：** 作为右翼定界符时，其前一个字符不能是 Unicode
  // 标点符号。CJK 全角标点（如 ）。）属于 Unicode 标点，会导致紧跟的
  // ** 加粗失效。在 CJK 标点与 ** 之间插入零宽空格来修复。
  markdown = markdown.replace(/([\u3000-\u303F\uFF00-\uFFEF])\*\*/g, '$1\u200B**')

  const out: string[] = []
  let state: ScanState = 'TEXT'
  let i = 0

  while (i < markdown.length) {
    if (state === 'TEXT') {
      // 围栏开始
      if (markdown.startsWith('```', i)) {
        state = 'FENCED_CODE_BACKTICK'
        out.push('```')
        i += 3
        continue
      }
      if (markdown.startsWith('~~~', i)) {
        state = 'FENCED_CODE_TILDE'
        out.push('~~~')
        i += 3
        continue
      }

      // 行内代码
      if (markdown[i] === '`') {
        state = 'INLINE_CODE'
        out.push('`')
        i += 1
        continue
      }

      // 块级 LaTeX: \[...\]
      if (markdown.startsWith('\\[', i)) {
        const contentStart = i + 2
        const closeIdx = findClosingDelim(markdown, contentStart, '\\[', '\\]')

        if (closeIdx === -1) {
          // 流式：未闭合，保持原文
          out.push('\\[')
          i += 2
          continue
        }

        // $$ 必须位于行首，remark-math 的块级规则才会匹配
        const content = markdown.slice(contentStart, closeIdx).trim()
        out.push('\n$$\n')
        out.push(content)
        out.push('\n$$\n')
        i = closeIdx + 2
        continue
      }

      // 行内 LaTeX: \(...\)
      if (markdown.startsWith('\\(', i)) {
        const contentStart = i + 2
        const closeIdx = findClosingDelim(markdown, contentStart, '\\(', '\\)')

        if (closeIdx === -1) {
          // 流式：未闭合，保持原文
          out.push('\\(')
          i += 2
          continue
        }

        const content = markdown.slice(contentStart, closeIdx).trim()
        out.push('$')
        out.push(content)
        out.push('$')
        i = closeIdx + 2
        continue
      }

      // 普通字符
      out.push(markdown[i])
      i += 1
    } else if (state === 'INLINE_CODE') {
      out.push(markdown[i])
      if (markdown[i] === '`') {
        state = 'TEXT'
      }
      i += 1
    } else if (state === 'FENCED_CODE_BACKTICK') {
      out.push(markdown[i])
      if (markdown.startsWith('```', i)) {
        state = 'TEXT'
        out.push('``')
        i += 3
        continue
      }
      i += 1
    } else if (state === 'FENCED_CODE_TILDE') {
      out.push(markdown[i])
      if (markdown.startsWith('~~~', i)) {
        state = 'TEXT'
        out.push('~~')
        i += 3
        continue
      }
      i += 1
    }
  }

  return out.join('')
}
