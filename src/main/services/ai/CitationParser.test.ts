import { describe, it, expect } from 'vitest'
import { cleanCitationText, CitationStreamBuffer } from './CitationParser'

describe('cleanCitationText', () => {
  // ── Rich citation（PUA 结构化）──

  it('removes rich citation \uE200cite\uE202turn0search0\uE202turn0search1\uE201', () => {
    const input = '\uE200cite\uE202turn0search0\uE202turn0search1\uE201'
    const { cleanText, citations } = cleanCitationText(input)
    expect(cleanText).toBe('')
    expect(citations).toHaveLength(2)
    expect(citations[0].id).toBe('turn0search0')
    expect(citations[1].id).toBe('turn0search1')
  })

  it('removes rich citation in middle of text', () => {
    const input = '晚型人可能更好。\uE200cite\uE202turn0search0\uE201\n- 下一行'
    const { cleanText, citations } = cleanCitationText(input)
    expect(cleanText).toBe('晚型人可能更好。\n- 下一行')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('turn0search0')
  })

  it('does not leave orphan "cite" after rich citation removal', () => {
    const input = 'A\uE200cite\uE202turn0search0\uE202turn0search1\uE201B'
    const { cleanText } = cleanCitationText(input)
    expect(cleanText).toBe('AB')
    expect(cleanText).not.toContain('cite')
  })

  it('classifies file source in rich citation', () => {
    const input = '\uE200cite\uE202turn0file0\uE201'
    const { citations } = cleanCitationText(input)
    expect(citations[0].id).toBe('turn0file0')
    expect(citations[0].type).toBe('file')
  })

  // ── 真实数据精确复现（来自 ChatGPT Hosted Search 实际 SSE 输出）──

  it('real data: 晚型人...更好。\uE200cite\uE202turn0search0\uE202turn0search1\uE201', () => {
    // 这是 2026-09-03 实际捕获的 ChatGPT Codex Hosted Search 输出
    const input = '晚型人下午或晚上可能更好。\uE200cite\uE202turn0search0\uE202turn0search1\uE201'
    const { cleanText, citations } = cleanCitationText(input)
    expect(cleanText).toBe('晚型人下午或晚上可能更好。')
    expect(cleanText).not.toContain('cite')
    expect(citations).toHaveLength(2)
    expect(citations[0].id).toBe('turn0search0')
    expect(citations[1].id).toBe('turn0search1')
  })

  it('real data: single source \uE200cite\uE202turn0search0\uE201', () => {
    const input = 'A\uE200cite\uE202turn0search0\uE201B'
    const { cleanText, citations } = cleanCitationText(input)
    expect(cleanText).toBe('AB')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('turn0search0')
  })

  it('PUA: does not leave orphan cite when family name differs', () => {
    const input = '\uE200web\uE202turn0search0\uE201'
    const { cleanText, citations } = cleanCitationText(input)
    expect(cleanText).toBe('')
    expect(cleanText).not.toContain('web')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('turn0search0')
  })

  // ── 中文括号 citation ──

  it('removes single CN bracket citation 【N†source】', () => {
    const { cleanText, citations } = cleanCitationText('你好【4†source】世界')
    expect(cleanText).toBe('你好世界')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('turn0search4')
    expect(citations[0].type).toBe('unknown')
  })

  it('removes multiple CN bracket citations', () => {
    const { cleanText, citations } = cleanCitationText('A【1†source】【2†source】B')
    expect(cleanText).toBe('AB')
    expect(citations).toHaveLength(2)
    expect(citations[0].id).toBe('turn0search1')
    expect(citations[1].id).toBe('turn0search2')
  })

  it('classifies file citation', () => {
    const { citations } = cleanCitationText('【1†file】')
    expect(citations[0].type).toBe('file')
  })

  // ── ASCII 括号 citation ──

  it('removes ASCII bracket citation [N†source]', () => {
    const { cleanText, citations } = cleanCitationText('hello [3†source] world')
    expect(cleanText).toBe('hello  world')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('turn0search3')
  })

  // ── contentReference ──

  it('removes contentReference[oaicite:N]', () => {
    const { cleanText, citations } = cleanCitationText(':contentReference[oaicite:1]{index=1}')
    expect(cleanText).toBe('')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('oaicite:1')
  })

  it('removes contentReference in middle of text', () => {
    const { cleanText } = cleanCitationText('前面:contentReference[oaicite:2]{index=2}后面')
    expect(cleanText).toBe('前面后面')
  })

  // ── 脚注 ──

  it('removes footnote citation [^N]', () => {
    const { cleanText, citations } = cleanCitationText('text[^1] more')
    expect(cleanText).toBe('text more')
    expect(citations[0].id).toBe('footnote:1')
  })

  // ── Markdown 链接 citation ──

  it('removes markdown citation link with turn0search', () => {
    const { cleanText, citations } = cleanCitationText('([example](https://example.com/turn0search0))')
    expect(cleanText).toBe('')
    expect(citations).toHaveLength(1)
    expect(citations[0].id).toBe('turn0search0')
    expect(citations[0].type).toBe('web')
  })

  it('does not remove normal markdown links', () => {
    const input = '([hello](https://normal.com/page))'
    const { cleanText } = cleanCitationText(input)
    expect(cleanText).toBe(input)
  })

  // ── 私有区 Unicode ──

  it('removes private-use Unicode characters', () => {
    const input = 'hello\uE000world\uF8FFend'
    const { cleanText } = cleanCitationText(input)
    expect(cleanText).toBe('helloworldend')
  })

  // ── 组合测试 ──

  it('handles text with multiple citation types', () => {
    const { cleanText, citations } = cleanCitationText(
      '你好【1†source】:contentReference[oaicite:2]{index=2}世界'
    )
    expect(cleanText).toBe('你好世界')
    expect(citations).toHaveLength(2)
  })

  // ── 裸 citation 块 ──

  it('removes bare cite + turn0search block', () => {
    const { cleanText, citations } = cleanCitationText('citeturn0search0turn0search1')
    expect(cleanText).toBe('')
    expect(citations).toHaveLength(2)
    expect(citations[0].id).toBe('turn0search0')
    expect(citations[1].id).toBe('turn0search1')
  })

  it('removes bare cite block in middle of text', () => {
    const { cleanText } = cleanCitationText('答案是citeturn0search0结束了')
    expect(cleanText).toBe('答案是结束了')
  })

  it('removes bare turn0search token without cite prefix', () => {
    const { cleanText, citations } = cleanCitationText('turn0search0')
    expect(cleanText).toBe('')
    expect(citations[0].id).toBe('turn0search0')
  })

  it('does not remove normal English word containing cite', () => {
    const { cleanText } = cleanCitationText('excited about the result')
    expect(cleanText).toBe('excited about the result')
  })

  // ── 边界情况 ──

  it('returns empty for empty input', () => {
    const { cleanText, citations } = cleanCitationText('')
    expect(cleanText).toBe('')
    expect(citations).toHaveLength(0)
  })

  it('preserves Chinese characters', () => {
    const { cleanText } = cleanCitationText('你好世界')
    expect(cleanText).toBe('你好世界')
  })

  it('preserves emoji', () => {
    const { cleanText } = cleanCitationText('hello 😀 world 🎉')
    expect(cleanText).toBe('hello 😀 world 🎉')
  })

  it('preserves markdown formatting', () => {
    const { cleanText } = cleanCitationText('**bold** and *italic*')
    expect(cleanText).toBe('**bold** and *italic*')
  })

  it('cleans empty parentheses left after citation removal', () => {
    const { cleanText } = cleanCitationText('text() more')
    expect(cleanText).toBe('text more')
  })
})

describe('CitationStreamBuffer', () => {
  it('passes through clean text unchanged', () => {
    const buf = new CitationStreamBuffer()
    const out = buf.feed('hello world')
    expect(out).toBe('hello world')
    expect(buf.flush()).toBe('')
  })

  it('holds partial rich citation until END arrives', () => {
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('A\uE200cit')
    expect(out1).toBe('A')
    const out2 = buf.feed('e\uE202turn0search0\uE201B')
    expect(out2).toBe('B')
    expect(buf.flush()).toBe('')
  })

  it('holds partial rich citation split at DELIM', () => {
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('A\uE200cite\uE202')
    expect(out1).toBe('A')
    const out2 = buf.feed('turn0search0\uE201B')
    expect(out2).toBe('B')
    expect(buf.flush()).toBe('')
  })

  it('removes complete citation in single chunk', () => {
    const buf = new CitationStreamBuffer()
    const out = buf.feed('hello【1†source】world')
    expect(out).toBe('helloworld')
    expect(buf.flush()).toBe('')
  })

  it('holds partial CN bracket until close bracket arrives', () => {
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('hello【1†sour')
    // 【1†sour 是不完整 citation，应被缓存
    expect(out1).toBe('hello')
    const out2 = buf.feed('ce】world')
    expect(out2).toBe('world')
    expect(buf.flush()).toBe('')
  })

  it('holds partial ASCII bracket citation', () => {
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('text [3†src')
    expect(out1).toBe('text ')
    const out2 = buf.feed('] more')
    expect(out2).toBe(' more')
    expect(buf.flush()).toBe('')
  })

  it('holds partial contentReference', () => {
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('prefix :contentRefer')
    expect(out1).toBe('prefix ')
    const out2 = buf.feed('ence[oaicite:1]{index=1} suffix')
    expect(out2).toBe(' suffix')
    expect(buf.flush()).toBe('')
  })

  it('holds partial contentReference split character by character', () => {
    const buf = new CitationStreamBuffer()
    const parts = [':', 'c', 'o', 'n', 't', 'e', 'n', 't', 'R', 'e', 'f', 'e', 'r', 'e', 'n', 'c', 'e', '[', 'o', 'a', 'i', 'c', 'i', 't', 'e', ':', '2', ']', '{', 'i', 'n', 'd', 'e', 'x', '=', '2', '}']
    const results: string[] = []
    for (const part of parts) {
      results.push(buf.feed(part))
    }
    results.push(buf.flush())
    // 所有 delta 都不应泄漏 contentReference 字符
    expect(results.join('')).toBe('')
  })

  it('handles contentReference in middle of sentence with single-char chunks', () => {
    const buf = new CitationStreamBuffer()
    const fullText = '测试引用：:contentReference[oaicite:2]{index=2}'
    const results: string[] = []
    for (const ch of fullText) {
      results.push(buf.feed(ch))
    }
    results.push(buf.flush())
    expect(results.join('')).toBe('测试引用：')
  })

  it('holds partial markdown citation link', () => {
    // Markdown link citations like ([text](url...turn0search)) can span chunks.
    // Fragments are cleaned at final save time by cleanFinalText, not during streaming.
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('text ](https://example.com/turn0')
    // First chunk passes through (URL is incomplete, no pattern matches)
    expect(out1).toBe('text ](https://example.com/turn0')
    const out2 = buf.feed('search0)) more')
    // Second chunk is cleaned independently — the URL fragment doesn't match alone
    expect(out2).toBe('search0)) more')
    expect(buf.flush()).toBe('')
  })

  it('flush returns remaining buffered text', () => {
    const buf = new CitationStreamBuffer()
    const out1 = buf.feed('hello【1')
    expect(out1).toBe('hello')
    // 不完整 citation 被缓存，flush 时作为普通文本返回
    const tail = buf.flush()
    expect(tail).toBe('【1')
  })

  it('handles multiple chunks correctly', () => {
    const buf = new CitationStreamBuffer()
    const chunks = ['hel', 'lo【1†', 'sour', 'ce】wor', 'ld']
    const results: string[] = []
    for (const chunk of chunks) {
      results.push(buf.feed(chunk))
    }
    results.push(buf.flush())
    expect(results.join('')).toBe('helloworld')
  })

  // ── char-by-char citation 不泄漏测试 ──

  it('char-by-char contentReference: no citation fragment leaks to any emit', () => {
    const raw = '测试引用：:contentReference[oaicite:2]{index=2}'
    const emitted: string[] = []
    const buf = new CitationStreamBuffer()
    let rendered = ''
    for (const ch of raw) {
      const out = buf.feed(ch)
      if (out) {
        emitted.push(out)
        rendered += out
        // 每个 emit 都不应含 citation 片段
        expect(out).not.toMatch(/contentReference|oaicite|index=/)
      }
      // 累计渲染也不应含 citation 片段
      expect(rendered).not.toMatch(/contentReference|oaicite|index=/)
    }
    const tail = buf.flush()
    if (tail) {
      emitted.push(tail)
      rendered += tail
    }
    expect(rendered).toBe('测试引用：')
  })

  it('char-by-char PUA rich citation: no cite/turn0search leaks to any emit', () => {
    const raw = '正文\uE200cite\uE202turn0search0\uE201后续'
    const emitted: string[] = []
    const buf = new CitationStreamBuffer()
    let rendered = ''
    for (const ch of raw) {
      const out = buf.feed(ch)
      if (out) {
        emitted.push(out)
        rendered += out
        expect(out).not.toMatch(/cite|turn\d+search|turn\d+file/)
        expect(out).not.toContain('\uE200')
        expect(out).not.toContain('\uE202')
        expect(out).not.toContain('\uE201')
      }
      expect(rendered).not.toMatch(/cite|turn\d+search|turn\d+file/)
      expect(rendered).not.toContain('\uE200')
    }
    const tail = buf.flush()
    if (tail) {
      emitted.push(tail)
      rendered += tail
    }
    expect(rendered).toBe('正文后续')
  })

  it('char-by-char: :hello (not a citation) is released once confirmed safe', () => {
    // :h 不是 :contentReference[ 的前缀，应立即释放
    const buf = new CitationStreamBuffer()
    let out = ''
    for (const ch of ':hello') {
      out += buf.feed(ch)
    }
    // : 被短暂 hold（是 citation 前缀候选），但 :h 不是，整段释放
    expect(out).toBe(':hello')
    const tail = buf.flush()
    expect(tail).toBe('')
  })

  it('collects all emitted deltas and checks none contain citation markers', () => {
    // 混合场景：正文 + contentReference + 正文 + PUA citation + 正文
    const raw = 'A:helloB:contentReference[oaicite:1]{index=1}C\uE200cite\uE202turn0search0\uE201D'
    const buf = new CitationStreamBuffer()
    const emitted: string[] = []
    let rendered = ''
    for (const ch of raw) {
      const out = buf.feed(ch)
      if (out) {
        emitted.push(out)
        rendered += out
      }
    }
    rendered += buf.flush()
    // 最终文本正确
    expect(rendered).toBe('A:helloBCD')
    // 所有 emit 过程中都不含 citation 片段
    for (const d of emitted) {
      expect(d).not.toMatch(/contentReference|oaicite|index=/)
      expect(d).not.toMatch(/cite|turn\d+search/)
      expect(d).not.toContain('\uE200')
      expect(d).not.toContain('\uE202')
      expect(d).not.toContain('\uE201')
    }
  })

  // ── 场景验证：疑似前缀普通文本 flush 必须原样释放 ──

  it('flush releases lone colon (:) unchanged', () => {
    const buf = new CitationStreamBuffer()
    expect(buf.feed(':')).toBe('') // 被 hold（citation 前缀候选）
    expect(buf.flush()).toBe(':') // 流结束，确认非 citation，原样释放
  })

  it('flush releases :contentRefX (looks like prefix but is not a citation) unchanged', () => {
    const buf = new CitationStreamBuffer()
    let out = ''
    for (const ch of ':contentRefX') {
      out += buf.feed(ch)
    }
    // 逐字符期间，:contentRefX 是 :contentReference[ 的前缀，被 hold
    out += buf.flush()
    expect(out).toBe(':contentRefX')
  })

  // ── 场景验证：同一条回复中连续多个 citation ──

  it('cleans multiple consecutive contentReference citations with no separator', () => {
    const raw = '正文:contentReference[oaicite:1]{index=1}:contentReference[oaicite:2]{index=2}正文'
    const buf = new CitationStreamBuffer()
    const emitted: string[] = []
    let rendered = ''
    for (const ch of raw) {
      const out = buf.feed(ch)
      if (out) {
        emitted.push(out)
        rendered += out
        expect(out).not.toMatch(/contentReference|oaicite|index=|:/)
      }
    }
    rendered += buf.flush()
    expect(rendered).toBe('正文正文')
  })

  it('cleans multiple consecutive PUA citations separated by newline', () => {
    const raw = '正文\uE200cite\uE202turn0search0\uE201\n\uE200cite\uE202turn0search1\uE201正文'
    const buf = new CitationStreamBuffer()
    const emitted: string[] = []
    let rendered = ''
    for (const ch of raw) {
      const out = buf.feed(ch)
      if (out) {
        emitted.push(out)
        rendered += out
        expect(out).not.toMatch(/cite|turn\d+search/)
        expect(out).not.toContain('\uE200')
        expect(out).not.toContain('\uE201')
        expect(out).not.toContain('\uE202')
      }
    }
    rendered += buf.flush()
    expect(rendered).toBe('正文\n正文')
  })

  it('cleans consecutive citation (non-streaming) via cleanCitationText', () => {
    const { cleanText } = cleanCitationText(
      '正文:contentReference[oaicite:1]{index=1}:contentReference[oaicite:2]{index=2}正文'
    )
    expect(cleanText).toBe('正文正文')
    const pua = cleanCitationText('正文\uE200cite\uE202turn0search0\uE201\n\uE200cite\uE202turn0search1\uE201正文')
    expect(pua.cleanText).toBe('正文\n正文')
  })
})