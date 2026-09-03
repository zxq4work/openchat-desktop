/**
 * CitationDebugTracker — 精确捕捉 ChatGPT Hosted Search 内部 citation 原始格式。
 *
 * 目的：一旦真实出现 citation，在控制台一次性打印完整诊断块，包括：
 * - 原始内容 + Unicode 码点（确认真实协议格式）
 * - citation 前后的正文（便于去 UI 精确定位是否泄漏）
 *
 * 仅诊断，不修改任何清理逻辑。
 */

import { cleanCitationText } from './CitationParser'

// 精确检测目前真实关注的字符与结构，避免大范围 PUA 正则误报
const CITATION_SIGNAL_RE =
  /[\uE200\uE201\uE202]|:contentReference\[|oaicite:\d+|turn\d+(?:search|file|news)\d+/

// 完整 contentReference 结构
const CONTENT_REF_COMPLETE_RE = /:contentReference\[oaicite:\d+\]\{index=\d+\}/

function toCodePoints(text: string): string {
  return Array.from(text)
    .map((char) => {
      const cp = char.codePointAt(0)!
      return `${JSON.stringify(char)}=U+${cp
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}`
    })
    .join(' ')
}

type CaptureType = 'pua' | 'contentReference' | null

interface CitationStart {
  type: Exclude<CaptureType, null>
  before: string
  seg: string
}

export class CitationDebugTracker {
  private tail = ''
  private captureType: CaptureType = null
  private captureBuffer = ''
  private capturePath = ''
  private contextBefore = ''
  private lastFingerprint = ''
  private orphanWatchUntil = 0
  private pendingAfter = false
  private afterBuffer = ''

  /**
   * 在 raw streaming delta 第一入口调用。
   * 维护最近 512 字符 rolling buffer，逐字符拆分的 citation 也能被拼接后检测。
   */
  feedRaw(delta: string, path: string): void {
    if (!delta) return
    this.tail = (this.tail + delta).slice(-512)

    // 状态 1：正在收集 citation 之后的正文
    if (this.pendingAfter) {
      const start = this.detectStart()
      if (start) {
        // 连续多个 citation：先收尾上一个的 after，再开始新的捕获
        this.printAfter()
        this.beginCapture(start, path)
        return
      }
      this.afterBuffer += delta
      if (this.shouldFlushAfter()) {
        this.printAfter()
      }
      return
    }

    // 状态 2：正在捕获 citation，拼接直到闭合
    if (this.captureType !== null) {
      this.captureBuffer += delta
      if (this.isComplete(this.captureType, this.captureBuffer)) {
        this.finishCapture()
      }
      return
    }

    // 状态 3：空闲，检测 citation 起始
    const start = this.detectStart()
    if (start) {
      this.beginCapture(start, path)
    }
  }

  /**
   * 在真正发送 UI 前调用，检测是否仍有 citation 泄漏。
   */
  checkEmit(text: string): void {
    if (!text) return
    if (CITATION_SIGNAL_RE.test(text)) {
      console.error('[citation-ui-leak]', JSON.stringify(text))
    }
    // 裸 cite 来源追踪：仅在刚捕获过 citation 后的短窗口内观察，避免误报正常英文 cite
    if (Date.now() < this.orphanWatchUntil && /\bcite\b/.test(text)) {
      console.error('[citation-orphan-cite]', JSON.stringify(text))
    }
  }

  /**
   * 流结束时调用：若 citation 之后没有足够后续文本，强制收尾 after。
   */
  flush(): void {
    if (this.pendingAfter) {
      this.printAfter()
    }
  }

  private detectStart(): CitationStart | null {
    const puaStart = this.tail.lastIndexOf('\uE200')
    if (puaStart >= 0) {
      const seg = this.tail.slice(puaStart)
      if (!seg.includes('\uE201')) {
        return { type: 'pua', before: this.tail.slice(0, puaStart).slice(-300), seg }
      }
    }

    const crStart = this.tail.lastIndexOf(':contentReference[')
    if (crStart >= 0) {
      const seg = this.tail.slice(crStart)
      if (!CONTENT_REF_COMPLETE_RE.test(seg)) {
        return { type: 'contentReference', before: this.tail.slice(0, crStart).slice(-300), seg }
      }
    }

    return null
  }

  private beginCapture(start: CitationStart, path: string): void {
    this.captureType = start.type
    this.captureBuffer = start.seg
    this.capturePath = path
    this.contextBefore = start.before
  }

  private isComplete(type: CaptureType, buf: string): boolean {
    if (type === 'pua') return buf.includes('\uE201')
    if (type === 'contentReference') return CONTENT_REF_COMPLETE_RE.test(buf)
    return false
  }

  private finishCapture(): void {
    const type = this.captureType
    const raw = this.captureBuffer
    const path = this.capturePath
    const before = this.contextBefore

    const fingerprint = raw
    if (fingerprint === this.lastFingerprint) {
      this.clearCaptureState()
      return
    }
    this.lastFingerprint = fingerprint
    this.orphanWatchUntil = Date.now() + 5000

    console.log('========== CITATION HIT ==========')
    console.log('[citation-hit/type]', type === 'pua' ? 'PUA' : 'contentReference')
    console.log('[citation-hit/path]', path)
    console.log('[citation-hit/raw]', JSON.stringify(raw))
    console.log('[citation-hit/codepoints]', toCodePoints(raw))
    const cleaned = cleanCitationText(raw)
    console.log('[citation-hit/cleaned]', JSON.stringify(cleaned.cleanText))

    console.log('========== CITATION CONTEXT ==========')
    console.log('[citation-context/before]', JSON.stringify(before))
    console.log('[citation-context/current]', JSON.stringify(raw))
    console.log('[citation-context/cleaned]', JSON.stringify(cleaned.cleanText))
    // 不打印结束分隔线，等待 after 累积

    this.clearCaptureState()
    this.pendingAfter = true
    this.afterBuffer = ''
  }

  private shouldFlushAfter(): boolean {
    if (this.afterBuffer.length >= 200) return true
    if (this.afterBuffer.length >= 30 && /[。！？\n.!?]/.test(this.afterBuffer)) return true
    return false
  }

  private printAfter(): void {
    console.log('[citation-context/after]', JSON.stringify(this.afterBuffer.slice(0, 200)))
    console.log('======================================')
    this.pendingAfter = false
    this.afterBuffer = ''
  }

  private clearCaptureState(): void {
    this.captureType = null
    this.captureBuffer = ''
    this.capturePath = ''
    this.contextBefore = ''
  }
}

export const citationDebugTracker = new CitationDebugTracker()
