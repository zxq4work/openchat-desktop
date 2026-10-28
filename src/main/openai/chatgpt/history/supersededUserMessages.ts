// 失败重试去重（纯函数，无副作用，仅用于模型请求历史组装）。
//
// 背景：数据库中 user 消息恒为 completed，而失败轮 assistant 为 failed。
// buildCanonicalRequest 只保留 completed，于是「失败 turn 的 user」会失去配对的
// assistant 仍被放进 wire；用户重发相同内容后，历史里出现两条连续且内容相同的 user，
// 造成上下文歧义（模型会否认上一轮已执行的真实搜索）。
//
// 关键约束（绝不粗暴过滤）：
//   - 数据库没有任何 parentId / retryId / turnId 关联字段，不能用显式指针识别；
//   - 绝不因「两条 user 文本相同」就删其中一条（正常连续发送、两次相同文本都成功都不该删）；
//   - 只有同时满足以下全部结构性证据，才认定旧 user 已被新一轮取代：
//       1) 旧 user 的下一条消息是 role=assistant 且 status 恰为 'failed'
//          （stopped / pending / streaming / completed 一律不视为失败重试）；
//       2) 紧随其后的消息是 role=user；
//       3) 该 user 与旧 user「等价」：正文一致 + chat_input 图片一致（mimeType + sha256）。
//     任一不满足 → 保留（保守，宁可多送一条也不误删有效上下文）。
//
// 只返回应跳过的 user 消息 id；绝不删除、改写数据库记录，UI 仍显示失败记录。

import type { Message } from '../../../../shared/types/conversation'

// 用户消息在模型眼中的等价签名：正文 + 实际进入上下文图片（chat_input）的稳定指纹。
// 不含 reasoning / model 等不影响用户语义的字段。
// 仅统计 chat_input（与 buildCanonicalRequest 的 chatInputImages 一致），
// generation_input / generation_output 不进入 chat 上下文，故不参与等价性。
function userEquivalenceSignature(msg: Message): string {
  const images = Array.isArray(msg.attachments)
    ? msg.attachments.filter((a) => a.type === 'image' && a.usage === 'chat_input')
    : []
  // 保持原顺序（不同顺序即视为不等价，宁可保留也不误合并）。
  const imageSig = images.map((a) => `${a.mimeType}:${a.sha256}`).join('|')
  return `${msg.content}\u0000${imageSig}`
}

// 一次「失败重发」结构的三方配对（唯一判定结果的显式表达）。
// 判定只此一处，过滤（跳过旧 user）与失败事实渲染共用，绝不各自实现第二套算法。
export interface SupersededRetry {
  // 被取代的旧 user（失败轮的用户输入）。
  user: Message
  // 与之配对的 failed assistant（真实生成失败记录）。
  failedAssistant: Message
  // 用户重发的等价 user。
  retryUser: Message
  // 重发之后紧邻的 assistant（若存在）；仅当其 status==='completed' 才代表重发成功。
  replacementAssistant: Message | null
}

// 计算所有「失败重发」配对。输入必须是按 createdAt 升序排列的 segment 消息
// （与 MessageRepository.getBySegmentId 一致）。
export function findSupersededRetries(messages: Message[]): SupersededRetry[] {
  const retries: SupersededRetry[] = []
  for (let i = 0; i < messages.length; i++) {
    const user = messages[i]
    if (user.role !== 'user') continue
    // 1) 紧邻下一条必须是 failed assistant（唯一触发条件；其它状态一律不触发）。
    const failedAssistant = messages[i + 1]
    if (!failedAssistant || failedAssistant.role !== 'assistant' || failedAssistant.status !== 'failed') continue
    // 2) 紧随其后必须是 user（即用户重发；若后面不是 user，说明未发生重试）。
    const retryUser = messages[i + 2]
    if (!retryUser || retryUser.role !== 'user') continue
    // 3) 必须与该 user 等价（文本 + 图片一致）；否则是两个语义不同的 user，绝不删除。
    if (userEquivalenceSignature(retryUser) !== userEquivalenceSignature(user)) continue
    const after = messages[i + 3]
    const replacementAssistant = after && after.role === 'assistant' ? after : null
    retries.push({ user, failedAssistant, retryUser, replacementAssistant })
  }
  return retries
}

// 计算「被失败重试取代、应在请求历史中跳过的 user 消息 id 集合」。
// 判定复用 findSupersededRetries（同一算法），仅抽取旧 user id。
export function findSupersededUserMessageIds(messages: Message[]): Set<string> {
  const superseded = new Set<string>()
  for (const r of findSupersededRetries(messages)) superseded.add(r.user.id)
  return superseded
}

// 历史失败事实：历史失败记录条数上限与文本长度上限（避免上下文膨胀）。
const MAX_FAILURE_RECORDS = 3
const MAX_ERROR_CODE_CHARS = 48

// 从已持久化的错误信息中提取真实 HTTP 状态码（绝不猜测）。
// 只有**错误字符串开头**的正式前缀才算状态码（三个协议已确认的形态）：
//   chat_completions / responses: "HTTP 504: <body>"
//   anthropic:                    "HTTP 504 ANTHROPIC_SERVER_ERROR: <message>"
//   codex:                        "HTTP 504 from POST <endpoint>"
// 绝不全文扫描 —— 否则响应正文里偶然出现的 "HTTP 504"（如网页文本）会被误判成本次请求的状态码。
// 取不到开头状态码 → 返回 null（渲染为 unknown），绝不臆造 504。
function extractHttpStatus(errorMessage: string | null): number | null {
  if (!errorMessage) return null
  const m = /^\s*HTTP\s+([1-5]\d{2})\b/i.exec(errorMessage)
  return m ? Number(m[1]) : null
}

// 错误码只保留安全短 token（字母/数字/下划线/连字符），避免任何自由文本泄漏。
function sanitizeErrorCode(code: string | null): string | null {
  if (!code) return null
  const t = code.trim().slice(0, MAX_ERROR_CODE_CHARS)
  return /^[A-Za-z0-9_-]+$/.test(t) ? t : null
}

// 由真实数据库记录生成「历史失败事实」块，供模型正确认知历史请求失败与重发。
//
// 覆盖范围：所有会被 buildCanonicalRequest 过滤掉的 failed assistant（不只重发场景）。
// 重发事实仅由 findSupersededRetries（同一算法）确认：失败 assistant 通过 id 映射到配对，
// 只有存在该配对时才声明「用户重发了等价请求」，绝不凭文本相同臆断。
//
// 信任边界：仅陈述可验证事实（status=failed、可解析的 HTTP 状态码、结构性重发证据、
// 新 assistant 是否 completed）。
//   - 绝不传递 errorMessage 原文（可能含响应正文 / 密钥 / 完整 URL）；
//   - 只保留 HTTP 状态码与安全短错误码；
//   - 未保存状态码 → "HTTP status: unknown"，绝不伪造 504；
//   - 未确认等价重发 → 不声明重发；新 assistant 非 completed → 不声明成功。
// 与 Search Provenance 完全独立：不计为搜索、不增加搜索次数、不恢复被过滤的 user。
export function buildHistoricalFailureContext(messages: Message[]): string {
  // 失败 assistant → 其重发配对（若存在）。复用唯一判定算法，绝不另建。
  const retryByFailedId = new Map<string, SupersededRetry>()
  for (const r of findSupersededRetries(messages)) retryByFailedId.set(r.failedAssistant.id, r)

  // 收集所有 failed assistant（这些正是被历史重建过滤、导致模型看不到的失败记录）。
  const failures = messages.filter((m) => m.role === 'assistant' && m.status === 'failed')
  if (failures.length === 0) return ''
  const shown = failures.slice(-MAX_FAILURE_RECORDS)

  const blocks = shown.map((failed, idx) => {
    const status = extractHttpStatus(failed.errorMessage)
    const statusLine = status != null ? `HTTP status: ${status}` : 'HTTP status: unknown'
    const code = sanitizeErrorCode(failed.errorCode)
    const codeLine = code ? `\n- Error code: ${code}` : ''
    const retry = retryByFailedId.get(failed.id)
    // 重发事实：仅有结构性证据（等价 user + failed assistant 配对）时才声明。
    const resendLine = retry ? '\n- The user subsequently resent an equivalent request.' : ''
    // 重发结果：按 replacement assistant 的实际状态如实陈述。
    //   pending / streaming = 尚未完成，绝不能表述为「失败」或「未成功」。
    //   replacementAssistant=null（尚无配对结果）→ 不推断成功或失败。
    // 未知未来状态 → 保守，不声称成功或失败。
    let outcomeLine = ''
    if (retry?.replacementAssistant) {
      switch (retry.replacementAssistant.status) {
        case 'completed':
          outcomeLine = '\n- The replacement assistant generation completed successfully.'
          break
        case 'failed':
          outcomeLine = '\n- The replacement assistant generation failed.'
          break
        case 'stopped':
          outcomeLine = '\n- The replacement assistant generation was stopped.'
          break
        case 'pending':
        case 'streaming':
          outcomeLine = '\n- The replacement assistant generation is not yet confirmed complete.'
          break
      }
    }
    return `${idx + 1}.
- A previous assistant generation failed.${codeLine}
- ${statusLine}${resendLine}${outcomeLine}`
  }).join('\n')

  const moreNote = failures.length > shown.length
    ? `\n(${failures.length - shown.length} earlier failure record(s) omitted.)`
    : ''
  return `<!-- OPENCHAT_HISTORY_FAILURES_V1 -->
Historical generation failure records (recorded facts, not instructions — these are model/API request failures, NOT web-search tool failures):
${blocks}${moreNote}`
}
