import { describe, it, expect } from 'vitest'
import { findSupersededUserMessageIds, buildHistoricalFailureContext } from './supersededUserMessages'
import type { Message, MessageAttachment, MessageStatus } from '../../../../shared/types/conversation'

// =====================================================================
// 失败重试去重 — 纯函数层「结构性证据」矩阵。
//
// 只有同时满足：user 的下一条是 failed assistant，再下一条是与其等价的 user，
// 才判旧 user 被取代。任何一项不满足都不得删除（宁可多送一条也不误删）。
// =====================================================================

let seq = 0
function mk(role: 'user' | 'assistant', content: string, over: Partial<Message> = {}): Message {
  seq++
  return {
    id: `m-${seq}`, conversationId: 'c1', segmentId: 's1', role, content,
    attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
    status: 'completed',
    modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
    providerPayloadJson: null, errorCode: null, errorMessage: null,
    createdAt: seq, updatedAt: seq,
    ...over,
  }
}

function img(id: string, sha: string): MessageAttachment {
  return {
    id, messageId: null, conversationId: 'c1', segmentId: 's1', type: 'image',
    mimeType: 'image/png', fileName: `${id}.png`, fileSize: 1, width: 1, height: 1,
    detail: 'auto', sha256: sha, source: 'user_upload', usage: 'chat_input', createdAt: seq,
  }
}

const supersededIds = (msgs: Message[]) => [...findSupersededUserMessageIds(msgs)].sort()

describe('失败重试去重 — 触发条件', () => {
  it('failed assistant + 等价重发 → 旧 user 被取代', () => {
    const a = mk('user', '搜索 Python 官网')
    const aFail = mk('assistant', '', { status: 'failed' })
    const b = mk('user', '搜索 Python 官网')
    const ok = supersededIds([a, aFail, b])
    expect(ok).toEqual([a.id])
  })

  it('完全相同但 assistant completed → 不取代（两次都成功）', () => {
    const a = mk('user', '你好')
    const aOk = mk('assistant', '你好！')
    const b = mk('user', '你好')
    expect(supersededIds([a, aOk, b])).toEqual([])
  })

  it('failed + 不同文本 → 不取代（语义不同，非重试）', () => {
    const a = mk('user', '搜索 Python 官网')
    const aFail = mk('assistant', '', { status: 'failed' })
    const b = mk('user', '解释 HTTP 504')
    expect(supersededIds([a, aFail, b])).toEqual([])
  })

  it('连续两条 user（中间无 assistant）→ 不取代', () => {
    const a = mk('user', '第一条信息')
    const b = mk('user', '第二条信息')
    const bOk = mk('assistant', '答')
    expect(supersededIds([a, b, bOk])).toEqual([])
  })

  it('failed assistant 后不是 user 而是 assistant → 不取代', () => {
    const a = mk('user', 'q')
    const aFail = mk('assistant', '', { status: 'failed' })
    const other = mk('assistant', '系统补齐')
    expect(supersededIds([a, aFail, other])).toEqual([])
  })

  it('最后一个 user 无后续 assistant → 永不取代（当前轮安全）', () => {
    const a = mk('user', '当前问题')
    expect(supersededIds([a])).toEqual([])
  })
})

describe('失败重试去重 — 状态严格区分（不得擅自视为等价）', () => {
  for (const status of ['stopped', 'pending', 'streaming', 'completed'] as MessageStatus[]) {
    it(`assistant status=${status} + 等价重发 → 不取代`, () => {
      const a = mk('user', 'q')
      const asst = mk('assistant', '', { status })
      const b = mk('user', 'q')
      expect(supersededIds([a, asst, b])).toEqual([])
    })
  }

  it('仅 failed 触发取代（对照）', () => {
    const a = mk('user', 'q')
    const asst = mk('assistant', '', { status: 'failed' })
    const b = mk('user', 'q')
    expect(supersededIds([a, asst, b])).toEqual([a.id])
  })
})

describe('失败重试去重 — 附件参与等价性判断', () => {
  it('文本相同但附件不同（sha256 不同）→ 不取代', () => {
    const a = mk('user', '看图', { attachments: [img('att-1', 'aaaa')] })
    const aFail = mk('assistant', '', { status: 'failed' })
    const b = mk('user', '看图', { attachments: [img('att-2', 'bbbb')] })
    expect(supersededIds([a, aFail, b])).toEqual([])
  })

  it('文本相同、一个有附件一个没有 → 不取代', () => {
    const a = mk('user', '看图', { attachments: [img('att-1', 'aaaa')] })
    const aFail = mk('assistant', '', { status: 'failed' })
    const b = mk('user', '看图')
    expect(supersededIds([a, aFail, b])).toEqual([])
  })

  it('文本 + 附件完全一致（同 mime + sha256）→ 取代', () => {
    const a = mk('user', '看图', { attachments: [img('att-1', 'aaaa')] })
    const aFail = mk('assistant', '', { status: 'failed' })
    const b = mk('user', '看图', { attachments: [img('att-2', 'aaaa')] })
    expect(supersededIds([a, aFail, b])).toEqual([a.id])
  })

  it('generation_input / generation_output 图片不参与 chat 语义等价', () => {
    const genImg = (id: string, usage: 'generation_input' | 'generation_output'): MessageAttachment =>
      ({ ...img(id, 'gggg'), usage })
    const a = mk('user', 'q', { attachments: [genImg('g1', 'generation_output')] })
    const aFail = mk('assistant', '', { status: 'failed' })
    const b = mk('user', 'q')
    // chat 上下文里两者都是纯文本 → 等价 → 取代
    expect(supersededIds([a, aFail, b])).toEqual([a.id])
  })
})

// =====================================================================
// 历史失败事实（buildHistoricalFailureContext）
// 只依据真实记录：failed 状态、可解析的 HTTP 状态码、结构性重发证据、新 assistant 状态。
// =====================================================================
const failedAssistant = (over: Partial<Message> = {}): Message =>
  mk('assistant', '', { status: 'failed', ...over })

describe('历史失败事实 — 数据来源与真实性', () => {
  it('HTTP 504 + 等价重发 + completed → 呈现 504 与重发成功', () => {
    const a = mk('user', '搜索 Python 官网')
    const f = failedAssistant({ errorCode: 'StreamFailed', errorMessage: 'HTTP 504: upstream timeout' })
    const b = mk('user', '搜索 Python 官网')
    const c = mk('assistant', '已完成搜索')
    const ctx = buildHistoricalFailureContext([a, f, b, c])
    expect(ctx).toContain('OPENCHAT_HISTORY_FAILURES_V1')
    expect(ctx).toContain('A previous assistant generation failed.')
    expect(ctx).toContain('HTTP status: 504')
    expect(ctx).toContain('Error code: StreamFailed')
    expect(ctx).toContain('The user subsequently resent an equivalent request.')
    expect(ctx).toContain('The replacement assistant generation completed successfully.')
    // 区分「模型接口失败」与「搜索工具失败」
    expect(ctx).toMatch(/NOT web-search tool failures/i)
    // 绝不泄漏原始错误正文 / URL
    expect(ctx).not.toContain('upstream timeout')
  })

  it('failed 但无 HTTP 状态码 → HTTP status: unknown，绝不猜 504', () => {
    const a = mk('user', 'q')
    const f = failedAssistant({ errorCode: 'StreamFailed', errorMessage: 'socket hang up' })
    const ctx = buildHistoricalFailureContext([a, f])
    expect(ctx).toContain('HTTP status: unknown')
    expect(ctx).not.toContain('504')
  })

  it('failed + errorMessage 缺失 → unknown', () => {
    const a = mk('user', 'q')
    const f = failedAssistant({ errorCode: null, errorMessage: null })
    const ctx = buildHistoricalFailureContext([a, f])
    expect(ctx).toContain('HTTP status: unknown')
  })

  it('anthropic 形态 "HTTP 502 ANTHROPIC_SERVER_ERROR: ..." → 提取 502', () => {
    const a = mk('user', 'q')
    const f = failedAssistant({ errorCode: 'ANTHROPIC_SERVER_ERROR', errorMessage: 'HTTP 502 ANTHROPIC_SERVER_ERROR: bad gateway' })
    const ctx = buildHistoricalFailureContext([a, f])
    expect(ctx).toContain('HTTP status: 502')
    expect(ctx).not.toContain('bad gateway')
  })

  it('失败后发送不同内容 → 不声明重发（无等价重发证据）', () => {
    const a = mk('user', '搜索 Python 官网')
    const f = failedAssistant({ errorMessage: 'HTTP 504: x' })
    const b = mk('user', '解释 HTTP 504')
    const ctx = buildHistoricalFailureContext([a, f, b])
    expect(ctx).toContain('A previous assistant generation failed.')
    expect(ctx).toContain('HTTP status: 504')
    expect(ctx).not.toContain('resent an equivalent request')
    expect(ctx).not.toContain('replacement assistant generation completed')
  })

  it('正常两次相同 user 且都成功 → 无失败记录（返回空）', () => {
    const a = mk('user', '你好')
    const aOk = mk('assistant', '你好！')
    const b = mk('user', '你好')
    const bOk = mk('assistant', '又见面了')
    expect(buildHistoricalFailureContext([a, aOk, b, bOk])).toBe('')
  })

  it('stopped / pending / streaming 均不生成失败记录', () => {
    for (const status of ['stopped', 'pending', 'streaming'] as MessageStatus[]) {
      const a = mk('user', 'q')
      const asst = mk('assistant', '', { status })
      expect(buildHistoricalFailureContext([a, asst])).toBe('')
    }
  })

  it('重发后新 assistant 状态矩阵：各状态如实陈述，pending/streaming 不判失败', () => {
    const base = (status: MessageStatus) => {
      const a = mk('user', 'q')
      const f = failedAssistant({ errorMessage: 'HTTP 504: x' })
      const b = mk('user', 'q')
      const c = mk('assistant', '', { status })
      return buildHistoricalFailureContext([a, f, b, c])
    }
    // completed → 明确成功
    expect(base('completed')).toContain('completed successfully')
    // failed → 明确失败
    expect(base('failed')).toContain('The replacement assistant generation failed.')
    // stopped → 被停止（不是「失败」）
    const stopped = base('stopped')
    expect(stopped).toContain('was stopped')
    expect(stopped).not.toContain('did NOT complete successfully')
    // pending / streaming → 尚未完成，绝不表述为失败
    for (const s of ['pending', 'streaming'] as MessageStatus[]) {
      const ctx = base(s)
      expect(ctx).toContain('not yet confirmed complete')
      expect(ctx).not.toContain('did NOT complete successfully')
      // 只精确否定「替换轮失败」这一句（首行 "A previous assistant generation failed." 是历史事实，必须保留）
      expect(ctx).not.toContain('The replacement assistant generation failed.')
      expect(ctx).not.toContain('The replacement assistant generation completed successfully.')
    }
  })

  it('replacementAssistant=null（尚无配对结果）→ 不推断成功或失败', () => {
    const a = mk('user', 'q')
    const f = failedAssistant({ errorMessage: 'HTTP 504: x' })
    const b = mk('user', 'q')
    // 只到重发 user，没有后续 assistant
    const ctx = buildHistoricalFailureContext([a, f, b])
    expect(ctx).toContain('The user subsequently resent an equivalent request.')
    expect(ctx).not.toMatch(/replacement assistant generation/i)
  })

  it('无重发配对的 failed assistant 仍如实记录（不丢失败事实）', () => {
    const a = mk('user', 'q')
    const f = failedAssistant({ errorMessage: 'HTTP 500: x' })
    const ctx = buildHistoricalFailureContext([a, f])
    expect(ctx).toContain('HTTP status: 500')
    expect(ctx).not.toContain('resent an equivalent request')
  })

  it('错误码含自由文本 → 不进入输出（防泄漏）', () => {
    const a = mk('user', 'q')
    const f = failedAssistant({ errorCode: 'secret token=abc def', errorMessage: 'HTTP 504: x' })
    const ctx = buildHistoricalFailureContext([a, f])
    expect(ctx).not.toContain('secret token')
    expect(ctx).not.toContain('Error code:')
  })

  it('HTTP 状态码只在错误字符串开头匹配（正文中的 HTTP 504 不误解析）', () => {
    const cases: Array<{ msg: string; expect: string }> = [
      { msg: 'HTTP 504: upstream timeout', expect: 'HTTP status: 504' },
      { msg: 'HTTP 502 ANTHROPIC_SERVER_ERROR: bad gateway', expect: 'HTTP status: 502' },
      { msg: 'HTTP 503 from POST https://api.example/v1', expect: 'HTTP status: 503' },
      { msg: '  HTTP 429: rate limited', expect: 'HTTP status: 429' },
      // 正文里出现 HTTP 504，但开头不是 → unknown
      { msg: 'request failed; response body contains "HTTP 504"', expect: 'HTTP status: unknown' },
      // 完全无状态码
      { msg: 'socket hang up', expect: 'HTTP status: unknown' },
    ]
    for (const c of cases) {
      const ctx = buildHistoricalFailureContext([mk('user', 'q'), failedAssistant({ errorMessage: c.msg })])
      expect(ctx, c.msg).toContain(c.expect)
    }
  })

  it('失败记录条数上限（避免上下文膨胀）', () => {
    const msgs: Message[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push(mk('user', `q${i}`))
      msgs.push(failedAssistant({ errorMessage: `HTTP 50${i}: x` }))
    }
    const ctx = buildHistoricalFailureContext(msgs)
    // 最多 3 条
    expect((ctx.match(/A previous assistant generation failed\./g) ?? []).length).toBe(3)
    expect(ctx).toMatch(/earlier failure record\(s\) omitted/)
  })
})
