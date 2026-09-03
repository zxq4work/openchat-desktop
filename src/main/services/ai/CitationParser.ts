/**
 * CitationParser — 从 OpenAI 返回的文本中提取 citation marker，返回干净文本与 citation 元数据。
 *
 * 支持 OpenAI Responses API / Web Search / File Search 产生的内部引用格式：
 * 1. Rich citation token：
 *    \uE200cite\uE202turn0search0\uE202turn0search1\uE201
 *    START(\uE200) + family + DELIM(\uE202) + source + DELIM + source ... + END(\uE201)
 * 2. 【N†source】            —— 中文括号 citation（Web/File Search 经典格式）
 * 3. [N†source]             —— ASCII 括号 citation
 * 4. :contentReference[oaicite:N]{index=N} —— 内联 contentReference
 * 5. [^N]                   —— 脚注式引用
 * 6. ([text](url...turn0search/file...)) —— Markdown 链接式 citation 泄漏
 * 7. 裸 citeturn0search0... 块（PUA 字符被剥离后的降级格式）
 *
 * 只精确匹配 citation pattern，绝不粗暴过滤非 ASCII 字符，避免误删中文/emoji/公式。
 */

export interface Citation {
  id: string
  type: 'web' | 'file' | 'unknown'
  source?: string
}

export interface ParseResult {
  cleanText: string
  citations: Citation[]
}

function inferCitationType(source: string): 'web' | 'file' | 'unknown' {
  if (!source) return 'unknown'
  if (/^file/i.test(source)) return 'file'
  if (/^turn\d+search/i.test(source)) return 'web'
  return 'unknown'
}

// ChatGPT/Codex rich citation token 结构定义
// 格式：\uE200 cite \uE202 turn0search0 \uE202 turn0search1 \uE201
const CITATION_START = '\uE200'
const CITATION_END = '\uE201'
const CITATION_DELIM = '\uE202'

// 匹配完整 rich citation：START + family + DELIM + body + END
const RICH_CITATION_RE = new RegExp(
  CITATION_START + '([\\w]+)' + CITATION_DELIM + '([\\s\\S]*?)' + CITATION_END,
  'g'
)

// 从 citation body 中提取 source token：turn0search0, turn0file0 等
const CITATION_SOURCE_RE = /turn(\d+)([a-zA-Z_]+)(\d+)/g

// 【N†source】 或 【N†source1†source2】（† 为 citation 的可靠判据）
const CN_BRACKET_CITATION_RE = /【(\d+)†([^】]*)】/g

// [N†source] 或 [N†source1†source2]
const ASCII_BRACKET_CITATION_RE = /\[(\d+)†([^\]]*)\]/g

// :contentReference[oaicite:N]{index=N}
const CONTENT_REFERENCE_RE = /:contentReference\[oaicite:(\d+)\]\{index=\d+\}/g

// [^N] 脚注式引用
const FOOTNOTE_CITATION_RE = /\[\^(\d+)\]/g

// Markdown 链接式 citation：([text](url-with-turn0search/turn0file))
const MARKDOWN_SEARCH_LINK_RE = /\(\[([^\]]*)\]\(([^)]*turn\d+(?:search|file)\d*[^)]*)\)\)/gi

// 单独出现的 turn0search/turn0file 裸 URL（非 markdown 链接形式）
const TURN_URL_RE = /https?:\/\/[^\s]*turn\d+(?:search|file)\d*[^\s]*/gi

// 裸 citation 块：citeturn0search0turn0search1（PUA 被剥离后的降级格式）
// 注意：带 g 标志，使用前必须重置 lastIndex
const BARE_CITATION_BLOCK_RE = /(?:cite)?(?:turn\d+(?:search|file)\d+)+/gi

// 单个裸 citation token（用于从块中提取 id）
const BARE_CITATION_TOKEN_RE = /turn(\d+)(search|file)(\d+)/gi

// 通用 citation 起始 token：文本尾部若等于这些 token 的任意非空前缀，视为可能的不完整 citation 起始。
// contentReference 是固定前缀，可逐字符前缀匹配；rich citation 因 body 可变，由 detectPartial 的
// START/END 状态机单独处理（见 rule 0），此处不重复收录。
const CITATION_PREFIXES = [':contentReference[']

// 返回 text 尾部能匹配到的某个 prefix 的最长非空前缀长度，无匹配返回 0。
function getPartialPrefixLength(text: string, prefixes: string[]): number {
  let best = 0
  for (const prefix of prefixes) {
    const max = Math.min(text.length, prefix.length)
    for (let len = max; len > 0; len--) {
      if (text.endsWith(prefix.slice(0, len))) {
        best = Math.max(best, len)
        break
      }
    }
  }
  return best
}

/**
 * 仅清理「自包含」的内联 citation marker，流式安全。
 * 处理顺序：
 * 1. Rich citation (PUA-structured) — 必须最先处理，确保家族名+源token整体删除
 * 2. 传统 bracket/脚注/contentReference
 * 3. 裸 citation 块（降级格式）
 * 4. 残余 PUA 字符清理
 */
function cleanInlineCitationText(text: string, citations: Citation[]): string {
  let cleaned = text

  // 1. Rich citation：START + family + DELIM + source + DELIM + source + ... + END
  // 必须最先处理，避免 PUA 分隔符导致 family 与 source 被拆散后残留
  cleaned = cleaned.replace(RICH_CITATION_RE, (_match, _family, body) => {
    CITATION_SOURCE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CITATION_SOURCE_RE.exec(body)) !== null) {
      citations.push({
        id: `turn${m[1]}${m[2]}${m[3]}`,
        type: m[2].toLowerCase() === 'file' ? 'file' : 'web',
      })
    }
    return ''
  })

  cleaned = cleaned.replace(CN_BRACKET_CITATION_RE, (_match, index, source) => {
    const src = String(source).trim()
    citations.push({
      id: `turn0search${index}`,
      type: inferCitationType(src),
      source: src || undefined,
    })
    return ''
  })

  cleaned = cleaned.replace(ASCII_BRACKET_CITATION_RE, (_match, index, source) => {
    const src = String(source).trim()
    citations.push({
      id: `turn0search${index}`,
      type: inferCitationType(src),
      source: src || undefined,
    })
    return ''
  })

  cleaned = cleaned.replace(CONTENT_REFERENCE_RE, (_match, index) => {
    citations.push({ id: `oaicite:${index}`, type: 'unknown' })
    return ''
  })

  cleaned = cleaned.replace(FOOTNOTE_CITATION_RE, (_match, index) => {
    citations.push({ id: `footnote:${index}`, type: 'unknown' })
    return ''
  })

  // Markdown 链接式 citation 必须在 BARE_CITATION_BLOCK_RE 之前处理，
  // 否则 BARE_CITATION_BLOCK_RE 会先吃掉 URL 中的 turn0search0，破坏链接结构。
  cleaned = cleaned.replace(MARKDOWN_SEARCH_LINK_RE, (_match, _text, url) => {
    const m = url.match(/turn(\d+)(search|file)(\d*)/i)
    if (m) {
      citations.push({
        id: `turn${m[1]}${m[2]}${m[3]}`,
        type: m[2].toLowerCase() === 'file' ? 'file' : 'web',
        source: url,
      })
    }
    return ''
  })

  // 裸 citation 块（降级格式）：必须重置 lastIndex 防止与 detectPartial 冲突
  BARE_CITATION_BLOCK_RE.lastIndex = 0
  cleaned = cleaned.replace(BARE_CITATION_BLOCK_RE, (_match) => {
    BARE_CITATION_TOKEN_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BARE_CITATION_TOKEN_RE.exec(_match)) !== null) {
      citations.push({
        id: `turn${m[1]}${m[2]}${m[3]}`,
        type: m[2].toLowerCase() === 'file' ? 'file' : 'web',
      })
    }
    return ''
  })

  return cleaned
}

/**
 * 对完整文本执行 citation 清理，返回干净文本 + citations。
 * 用于非流式场景、消息保存前、历史消息读取时。
 */
export function cleanCitationText(text: string): ParseResult {
  if (!text) return { cleanText: '', citations: [] }

  const citations: Citation[] = []

  let cleaned = cleanInlineCitationText(text, citations)

  cleaned = cleaned.replace(TURN_URL_RE, () => '')

  // 清理 citation 移除后残留的空括号对
  cleaned = cleaned.replace(/\(\s*\)/g, '')
  // 清理残留的多余空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  // 最后清理残余的孤立 PUA 字符（citation token 已全部提取，剩余 PUA 为无意义控制字符）
  cleaned = cleaned.replace(/[\uE000-\uF8FF\uFFF0-\uFFFF]/g, '')

  return { cleanText: cleaned, citations }
}

// ---------------------------------------------------------------------------
// 流式 CitationStreamBuffer
// ---------------------------------------------------------------------------

type PartialMatch =
  | { kind: 'cn_bracket'; matched: string }
  | { kind: 'ascii_bracket'; matched: string }
  | { kind: 'content_ref'; matched: string }
  | { kind: 'rich_citation'; matched: string }
  | { kind: 'bare_citation'; matched: string }

/**
 * 流式缓冲区：缓存跨 chunk 截断的 citation marker 前缀，防止 citation 在流中泄漏。
 *
 * 使用方式：
 * ```
 * const buf = new CitationStreamBuffer()
 * for (const chunk of chunks) {
 *   const out = buf.feed(chunk)      // 逐 chunk 喂入
 *   // 发送 out 到 UI
 * }
 * const tail = buf.flush()           // 清空残余
 * ```
 */
export class CitationStreamBuffer {
  private buffer = ''

  /** 喂入一个 chunk，返回可安全输出的干净文本。 */
  feed(chunk: string): string {
    if (!chunk) return ''
    const combined = this.buffer + chunk
    this.buffer = ''

    const partial = this.detectPartial(combined)
    if (partial) {
      this.buffer = partial.matched
      const safe = combined.slice(0, -partial.matched.length)
      const { cleanText } = cleanCitationText(safe)
      return cleanText
    }

    const { cleanText } = cleanCitationText(combined)
    return cleanText
  }

  /** 刷新缓冲区，返回剩余文本。若无残留则返回空字符串。 */
  flush(): string {
    if (!this.buffer) return ''
    const { cleanText } = cleanCitationText(this.buffer)
    this.buffer = ''
    return cleanText
  }

  /**
   * 检测 combined 末尾是否残留不完整的 citation marker 前缀。
   * 返回 null 表示末尾没有需要缓存的内容，可以全部输出。
   *
   * 核心原则：只要发现 citation START 但没有 STOP，就缓存从 START 开始的全部内容。
   */
  private detectPartial(combined: string): PartialMatch | null {
    if (!combined) return null

    // 0. Rich citation START 但没有 END → 缓存从 START 开始的全部内容
    const lastStart = combined.lastIndexOf(CITATION_START)
    if (lastStart !== -1) {
      const after = combined.slice(lastStart)
      if (!after.includes(CITATION_END)) {
        return { kind: 'rich_citation', matched: after }
      }
    }

    // 1. 中文括号 citation 前缀：`【` 后可能是不完整的内容
    const lastCn = combined.lastIndexOf('【')
    if (lastCn !== -1) {
      const after = combined.slice(lastCn)
      if (!after.includes('】')) {
        return { kind: 'cn_bracket', matched: after }
      }
    }

    // 2. ASCII bracket citation 前缀：`[` 后跟数字（防止误匹配普通 Markdown 链接）
    const lastBracket = combined.lastIndexOf('[')
    if (lastBracket !== -1) {
      const after = combined.slice(lastBracket)
      if (!after.includes(']')) {
        // 至少后跟一个数字才认定为 citation 前缀（\d+ 而非 \d*，避免 [ 单独匹配）
        if (/^\[\d+$/.test(after) || /^\[\d+†/.test(after)) {
          return { kind: 'ascii_bracket', matched: after }
        }
        // 也可能是 [^ 脚注前缀（[^ 或 [^N 形式）
        if (/^\[\^?\d+$/.test(after) || /^\[\^$/.test(after)) {
          return { kind: 'ascii_bracket', matched: after }
        }
      }
    }

    // 3. contentReference 通用前缀 holdback（完整格式 :contentReference[oaicite:N]{index=N}）
    // 两种情况：
    //   a) 完整 contentReference 已出现但尚未闭合（缺 }），缓存整段等待闭合
    //   b) 尾部是 :contentReference[ 的任意非空前缀（:、:c、:co ... :contentReference[），逐字符缓存
    const crIdx = combined.lastIndexOf(':contentReference[')
    if (crIdx >= 0) {
      const after = combined.slice(crIdx)
      if (!/\]\{index=\d+\}/.test(after)) {
        return { kind: 'content_ref', matched: after }
      }
    }
    const prefixLen = getPartialPrefixLength(combined, CITATION_PREFIXES)
    if (prefixLen > 0) {
      return { kind: 'content_ref', matched: combined.slice(-prefixLen) }
    }

    // 4. 裸 citation 块前缀（降级格式）：citeturn0sear 等被截断的 token
    const citeIdx = combined.lastIndexOf('cite')
    if (citeIdx >= 0) {
      // cite 前必须是单词边界（非字母），排除 "excite"/"recite"
      if (citeIdx > 0 && /[a-zA-Z]/.test(combined[citeIdx - 1])) {
        return null
      }
      const after = combined.slice(citeIdx)
      if (/^citeturn\d*(?:s(?:e(?:a(?:r(?:c(?:h)?)?)?)?|f(?:i(?:l(?:e)?)?)?)?)?\d*$/i.test(after) &&
          !BARE_CITATION_BLOCK_RE.test(after)) {
        BARE_CITATION_BLOCK_RE.lastIndex = 0
        return { kind: 'bare_citation', matched: after }
      }
      BARE_CITATION_BLOCK_RE.lastIndex = 0
    }

    return null
  }
}
