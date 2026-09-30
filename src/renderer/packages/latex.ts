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
 *
 * 额外：在 TEXT 状态对 `**` 做 flanking 修复（见 shouldFixOpen/Close）——
 * 通过临时插入 BOLD_SENTINEL 改变 `**` 邻接字符分类，parse 后由
 * remarkStripBoldSentinel 移除，不进入最终 DOM。
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

// 专用 sentinel：U+FDD0 是 Unicode 永久保留的「非字符」（Plane 0 noncharacter），
// 既不会被用户/模型当成正常内容生成，也不会被 Unicode 分类为 whitespace
// （/\s/ 不匹配）或 punctuation（/\p{P}|\p{S}/u 不匹配），因此 classifyCharacter()
// 返回 undefined（普通字符）。
// 它只用于临时改变 `**` 邻接字符的分类，parse 之后由 stripBoldSentinel 从 mdast 精确移除，
// 绝不进入最终 DOM / clipboard。
export const BOLD_SENTINEL = '\uFDD0'
// CommonMark 标点分类与 micromark 一致：Unicode P（标点）/ S（符号）类别
const PUNCT_RE = /[\p{P}\p{S}]/u

// 行首（undefined）与空白均按 CommonMark 的 whitespace 处理
function isSpaceOrEdge(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch)
}

// 起始 ** 需要修复：前面是「普通字符」（非空白/标点/行首）且后面紧跟标点。
// 此类 ** 会被 CommonMark 判为 not-left-flanking（next 是标点且 prev 也是普通字符）→
// 无法打开 strong。修复方式：在 ** 之后插入 sentinel，使 next 变为普通字符。
function shouldFixOpen(prev: string | undefined, next: string | undefined): boolean {
  return (
    prev !== undefined && !isSpaceOrEdge(prev) && !PUNCT_RE.test(prev) &&
    next !== undefined && PUNCT_RE.test(next)
  )
}

// 闭合 ** 需要修复：前面是标点且后面是「普通字符」。
// 此类 ** 会被 CommonMark 判为 not-right-flanking（prev 是标点且 next 也是普通字符）→
// 无法闭合 strong。修复方式：在 ** 之前插入 sentinel，使 prev 变为普通字符。
function shouldFixClose(prev: string | undefined, next: string | undefined): boolean {
  return (
    prev !== undefined && PUNCT_RE.test(prev) &&
    next !== undefined && !isSpaceOrEdge(next) && !PUNCT_RE.test(next)
  )
}

export function processLaTeX(markdown: string): string {
  if (!markdown) return ''

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

      // 加粗定界符 ** flanking 修复：
      // LLM 常生成「正文**「引号」**」这类写法，开/闭 ** 因紧邻标点被
      // CommonMark 判为 not-left/right-flanking，导致 ** 原样显示而非加粗。
      // 仅在 TEXT 状态（代码区域由状态机隔离）对确需修复的 ** 插入 sentinel，
      // parse 后由 remarkStripBoldSentinel 从 mdast 移除，不进入 DOM。
      // 仅处理「孤立的 **」（前后均非 * / 反斜杠转义），避免破坏 *** 与 escaped \*。
      if (
        markdown.startsWith('**', i) &&
        markdown[i - 1] !== '*' &&
        markdown[i - 1] !== '\\' &&
        markdown[i + 2] !== '*'
      ) {
        // 与 micromark 对齐：context.previous 暴露的是单个 UTF-16 code unit，
        // 因此这里按 code unit 判断邻接字符（astral emoji 的代理项本身就属
        // Unicode So 类别，会被 \p{S} 命中）。
        const prev = i > 0 ? markdown[i - 1] : undefined
        const next = i + 2 < markdown.length ? markdown[i + 2] : undefined
        if (shouldFixOpen(prev, next)) {
          out.push('*', '*', BOLD_SENTINEL)
          i += 2
          continue
        }
        if (shouldFixClose(prev, next)) {
          out.push(BOLD_SENTINEL, '*', '*')
          i += 2
          continue
        }
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
