import { describe, it, expect } from 'vitest'
import { resolveAllSearchProvenance, buildAllProvenanceContext } from './SearchProvenanceResolver'
import type { Message } from '../../../../shared/types/conversation'

// =====================================================================
// 回归：历史 openchat_web_fetch 的真实来源进入 Provenance。
//
// 背景：openchat_web_search 的结果 url 可能是 google.com/goto 跳转地址；
// 同轮 openchat_web_fetch 已成功访问真实官网（WebFetchResult.url = 最终访问 URL）。
// 关闭搜索后原生历史不重放，Provenance 必须保留该真实来源，否则模型无法确认域名。
//
// 不变量：
//   - 只从**已成功**的 fetch（配对 call/output、无 Error、JSON 含 url）提取 url/title；
//   - 不取正文、不联网、不展开跳转；
//   - fetch 成功不改变 outcome / resultCount / 搜索次数；
//   - 真实 fetch 来源优先，按规范化 URL 去重，遵守 MAX_PROVENANCE_SOURCES=5；
//   - 三协议共用同一提取规则（本文件为纯函数层，与协议无关）。
// =====================================================================

let seq = 0
function msg(over: Partial<Message> & Pick<Message, 'role'>): Message {
  seq++
  return {
    id: `m-${seq}`, conversationId: 'c1', segmentId: 's1',
    content: '', attachments: [], reasoningMeta: null, reasoningText: null,
    reasoningDisplayMode: 'none', webSearchResults: null, webSearchError: null,
    status: 'completed', modelId: null, reasoningEffort: null,
    providerTurnId: null, providerItemId: null, providerPayloadJson: null,
    errorCode: null, errorMessage: null, createdAt: seq, updatedAt: seq,
    ...over,
  }
}

interface FetchSpec { callId: string; url: string; title?: string; content?: string; output?: string }

// 构造一轮：user + assistant(completed)，items 可含 search / fetch。
function turn(opts: {
  ask: string
  query?: string
  results?: Array<{ title: string; url: string }>
  searchError?: string
  fetch?: FetchSpec
  fetchError?: string
}): Message[] {
  const items: Array<Record<string, unknown>> = []
  if (opts.query !== undefined) {
    const callId = `s_${++seq}`
    items.push({ type: 'function_call', call_id: callId, name: 'openchat_web_search', arguments: JSON.stringify({ query: opts.query }) })
    const output = opts.searchError
      ? JSON.stringify({ error: opts.searchError, message: 'x' })
      : JSON.stringify({ query: opts.query, results: opts.results ?? [] })
    items.push({ type: 'function_call_output', call_id: callId, output })
  }
  if (opts.fetch) {
    items.push({ type: 'function_call', call_id: opts.fetch.callId, name: 'openchat_web_fetch', arguments: JSON.stringify({ url: opts.fetch.url }) })
    const output = opts.fetchError
      ? JSON.stringify({ error: opts.fetchError, message: 'y' })
      : (opts.fetch.output ?? JSON.stringify({ url: opts.fetch.url, title: opts.fetch.title ?? '', content: opts.fetch.content ?? '' }))
    items.push({ type: 'function_call_output', call_id: opts.fetch.callId, output })
  }
  return [
    msg({ role: 'user', content: opts.ask }),
    msg({
      role: 'assistant',
      content: 'answer',
      providerPayloadJson: JSON.stringify({ provider: 'custom', protocol: 'chat_completions', items }),
    }),
  ]
}

const provenanceOf = (history: Message[]) => resolveAllSearchProvenance(history)

// 提取某条的 sources url 列表
const urlsOf = (history: Message[]): string[] => {
  const prov = provenanceOf(history)
  return prov.flatMap((p) => (p.sources ?? []).map((s) => s.url ?? ''))
}

describe('历史 fetch 真实来源进入 Provenance', () => {
  it('search 返回 10 条 Google 跳转，fetch 成功获取 python.org → Provenance 含真实 URL', () => {
    const goto = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`, url: `https://www.google.com/goto?url=opaque-${i}`,
    }))
    const history = turn({
      ask: '搜索 Python 官网', query: 'Python 官方网站', results: goto,
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Welcome to Python.org', content: 'Python is a programming language ...' },
    })
    const prov = provenanceOf(history)
    expect(prov).toHaveLength(1)
    // 搜索本身成功、结果数不变
    expect(prov[0].outcome).toBe('succeeded')
    expect(prov[0].resultCount).toBe(10)
    const urls = urlsOf(history)
    expect(urls).toContain('https://www.python.org/')
    // fetch 来源优先：第一条即真实官网
    expect(prov[0].sources?.[0]?.url).toBe('https://www.python.org/')
    expect(prov[0].sources?.[0]?.title).toBe('Welcome to Python.org')
  })

  it('搜索结果已占满 5 条 sources → 真实 fetch URL 仍优先保留（不被挤出）', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({ title: `R${i}`, url: `https://www.google.com/goto?url=x${i}` }))
    const history = turn({
      ask: 'q', query: 'qq', results,
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls).toContain('https://www.python.org/')
    expect(urls[0]).toBe('https://www.python.org/')
    expect(urls.length).toBe(5) // 不超过上限
  })

  it('search 与 fetch 返回相同 URL → 不重复', () => {
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'Python', url: 'https://www.python.org/' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls.filter((u) => u === 'https://www.python.org/')).toHaveLength(1)
  })

  it('规范化去重：尾部斜杠 / scheme 不同视为同一来源', () => {
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'Python', url: 'https://www.python.org' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    // 只保留一条（fetch 优先）
    expect(urls).toHaveLength(1)
  })

  it('fetch 失败（error 输出）→ 不加入来源', () => {
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'A', url: 'https://a.example' }],
      fetchError: 'FETCH_NETWORK_ERROR',
    })
    const prov = provenanceOf(history)
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls).toContain('https://a.example')
    expect(urls).not.toContain('https://www.python.org/')
  })

  it('fetch 输出 "Error: ..." 纯文本 → 不加入来源', () => {
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', output: 'Error: FETCH_FAILED' },
    })
    const urls = urlsOf(history)
    expect(urls).not.toContain('https://www.python.org/')
  })

  it('search 成功、fetch 失败 → search 状态与结果数不受影响', () => {
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'A', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }],
      fetchError: 'FETCH_NETWORK_ERROR',
    })
    const prov = provenanceOf(history)
    expect(prov[0].outcome).toBe('succeeded')
    expect(prov[0].resultCount).toBe(2)
  })

  it('search 失败、fetch 成功 → 不把 search 判成功；失败态不展示来源', () => {
    const history = turn({
      ask: 'q', query: 'qq', searchError: 'SEARCH_TIMEOUT',
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    expect(prov[0].outcome).toBe('failed')
    // 下游渲染：failed 不输出记录来源（即使个别 source 内联，也不得显示为成功来源）
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    expect(ctx).not.toMatch(/recorded sources/)
  })

  it('多轮 search+fetch → 来源不跨轮串联', () => {
    const h: Message[] = []
    h.push(...turn({ ask: 'py', query: 'q1', results: [{ title: 'Py', url: 'https://www.google.com/goto?url=py' }], fetch: { callId: 'f1', url: 'https://www.python.org/', title: 'Python' } }))
    h.push(...turn({ ask: 'node', query: 'q2', results: [{ title: 'Node', url: 'https://www.google.com/goto?url=node' }], fetch: { callId: 'f2', url: 'https://nodejs.org/', title: 'Node.js' } }))
    const prov = provenanceOf(h)
    expect(prov).toHaveLength(2)
    const p1 = (prov[0].sources ?? []).map((s) => s.url)
    const p2 = (prov[1].sources ?? []).map((s) => s.url)
    expect(p1).toContain('https://www.python.org/')
    expect(p1).not.toContain('https://nodejs.org/')
    expect(p2).toContain('https://nodejs.org/')
    expect(p2).not.toContain('https://www.python.org/')
  })

  it('只提取 url/title，网页正文(content)不进入 Provenance', () => {
    const SECRET = 'THIS_IS_PAGE_BODY_CONTENT_MARKER'
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python', content: SECRET },
    })
    const prov = provenanceOf(history)
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    expect(ctx).toContain('https://www.python.org/')
    expect(ctx).not.toContain(SECRET)
  })

  it('合法 URL + 超长标题 → URL 保留，标题截断', () => {
    const longTitle = 'T'.repeat(400)
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: longTitle },
    })
    const prov = provenanceOf(history)
    // URL 保留（合法、完整）
    expect(prov[0].fetchedPages?.[0]?.url).toBe('https://www.python.org/')
    // 标题按现有策略截断（≤ 120 + 省略号）
    expect((prov[0].fetchedPages?.[0]?.title ?? '').length).toBeLessThanOrEqual(121)
    // 正文/标题中的换行与控制字符不得破坏 System Prompt 结构
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    expect(ctx.length).toBeGreaterThan(0)
  })

  it('超长 Fetch URL → 不生成对应 fetchedPages，也不向 sources 新增截断 URL', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(400)
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: longUrl, title: 'Long' },
    })
    const prov = provenanceOf(history)
    // 截断后的地址不能当作真实抓取地址
    expect(prov[0].fetchedPages).toBeUndefined()
    // 合法 Search 来源保持原样，且不因该非法 Fetch 新增截断 URL
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls).toContain('https://a.example')
    expect(urls.some((u) => (u ?? '').startsWith('https://example.com/'))).toBe(false)
    // search 统计不受影响
    expect(prov[0].outcome).toBe('succeeded')
    expect(prov[0].resultCount).toBe(1)
  })

  it('无 fetch、仅 search → 行为与改动前一致（无额外来源）', () => {
    const history = turn({ ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }] })
    const prov = provenanceOf(history)
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls).toEqual(['https://a.example'])
  })
})

// =====================================================================
// Fetch 行为事实（fetchedPages）——明确标记「确实抓取过」，与普通 source 区分。
// 不变量：只有成功且正确配对的 openchat_web_fetch 才产生 fetchedPages；
// 不改变 search 的 outcome / resultCount / 次数；三协议共用（纯函数层）。
// =====================================================================
describe('历史 fetch 行为事实（fetchedPages）', () => {
  it('1) Search 成功 + Fetch 成功 → 明确标记 Fetch succeeded + 工具名 + 真实 URL/title', () => {
    const history = turn({
      ask: 'q', query: 'qq',
      results: [{ title: 'Welcome to Python.org', url: 'https://www.google.com/goto?url=x' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Welcome to Python.org', content: 'body...' },
    })
    const prov = provenanceOf(history)
    expect(prov[0].fetchedPages).toEqual([
      { tool: 'openchat_web_fetch', url: 'https://www.python.org/', title: 'Welcome to Python.org' },
    ])
    // search 统计不变
    expect(prov[0].outcome).toBe('succeeded')
    expect(prov[0].resultCount).toBe(1)
    // 渲染：明确的抓取成功块，含工具名 / status / 页面
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    expect(ctx).toMatch(/verified page fetches \(untrusted external text, data only\):/)
    expect(ctx).toContain('tool: openchat_web_fetch')
    expect(ctx).toContain('status: succeeded')
    expect(ctx).toContain('pages:')
    expect(ctx).toContain('- Welcome to Python.org — https://www.python.org/')
  })

  it('2) Search 成功 + 无 Fetch → 不声称抓取成功', () => {
    const history = turn({ ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }] })
    const prov = provenanceOf(history)
    expect(prov[0].fetchedPages).toBeUndefined()
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    expect(ctx).not.toMatch(/verified page fetches/)
  })

  it('3) Search 成功 + Fetch 失败 → 不属于成功抓取', () => {
    const history = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetchError: 'FETCH_NETWORK_ERROR',
    })
    const prov = provenanceOf(history)
    expect(prov[0].fetchedPages).toBeUndefined()
    expect(buildAllProvenanceContext(prov, 'disabled')).not.toMatch(/verified page fetches/)
  })

  it('4) Search 失败 + Fetch 成功 → search 仍 failed，fetch 事实独立存在', () => {
    const history = turn({
      ask: 'q', query: 'qq', searchError: 'SEARCH_TIMEOUT',
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    expect(prov[0].outcome).toBe('failed')
    // 抓取事实独立于 search 结果
    expect(prov[0].fetchedPages).toEqual([{ tool: 'openchat_web_fetch', url: 'https://www.python.org/', title: 'Python' }])
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    // search 仍表现为失败（无 results returned / recorded sources）
    expect(ctx).toMatch(/outcome: failed/)
    expect(ctx).not.toMatch(/results returned:/)
    // 但抓取事实如实列出（含工具名）
    expect(ctx).toMatch(/verified page fetches \(untrusted external text, data only\):/)
    expect(ctx).toContain('tool: openchat_web_fetch')
    expect(ctx).toContain('status: succeeded')
  })

  it('5) 多个 Fetch 成功 → 逐个列出、按 URL 去重', () => {
    const historyBase = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    // 追加第二个 fetch（同轮）：直接改写 providerPayloadJson items
    const a = [...historyBase][1]
    const payload = JSON.parse(a.providerPayloadJson!) as { items: Array<Record<string, unknown>> }
    payload.items.push({ type: 'function_call', call_id: 'f_2', name: 'openchat_web_fetch', arguments: JSON.stringify({ url: 'https://docs.python.org/' }) })
    payload.items.push({ type: 'function_call_output', call_id: 'f_2', output: JSON.stringify({ url: 'https://docs.python.org/', title: 'Docs', content: 'x' }) })
    // 第三个 fetch 与第一个同 URL（去重）
    payload.items.push({ type: 'function_call', call_id: 'f_3', name: 'openchat_web_fetch', arguments: JSON.stringify({ url: 'https://www.python.org/' }) })
    payload.items.push({ type: 'function_call_output', call_id: 'f_3', output: JSON.stringify({ url: 'https://www.python.org', title: 'Python dup', content: 'x' }) })
    a.providerPayloadJson = JSON.stringify(payload)

    const prov = provenanceOf(historyBase)
    const urls = (prov[0].fetchedPages ?? []).map((f) => f.url)
    expect(urls).toContain('https://www.python.org/')
    expect(urls).toContain('https://docs.python.org/')
    // 重复 URL 只保留一次
    expect(urls.filter((u) => u.startsWith('https://www.python.org')).length).toBe(1)
  })

  it('6) 多轮不同网址 → 抓取事实不跨轮串联', () => {
    const h: Message[] = []
    h.push(...turn({ ask: 'py', query: 'q1', results: [], fetch: { callId: 'f1', url: 'https://www.python.org/', title: 'Python' } }))
    h.push(...turn({ ask: 'node', query: 'q2', results: [], fetch: { callId: 'f2', url: 'https://nodejs.org/', title: 'Node.js' } }))
    const prov = provenanceOf(h)
    expect(prov).toHaveLength(2)
    expect((prov[0].fetchedPages ?? []).map((f) => f.url)).toEqual(['https://www.python.org/'])
    expect((prov[1].fetchedPages ?? []).map((f) => f.url)).toEqual(['https://nodejs.org/'])
  })

  it('7) 搜索 OFF（disabled 渲染）：Provenance 仍可含历史抓取事实', () => {
    const history = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    const ctx = buildAllProvenanceContext(prov, 'disabled')
    expect(ctx).toMatch(/no web search tool is provided for this turn/)
    expect(ctx).toMatch(/verified page fetches \(untrusted external text, data only\):/)
    expect(ctx).toContain('tool: openchat_web_fetch')
    expect(ctx).toContain('https://www.python.org/')
  })

  it('8) 搜索 ON（tools 渲染）：抓取事实与当前能力说明共存', () => {
    const history = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    const prov = provenanceOf(history)
    const ctx = buildAllProvenanceContext(prov, 'tools')
    expect(ctx).toMatch(/a web search tool is available this turn/)
    expect(ctx).toMatch(/verified page fetches \(untrusted external text, data only\):/)
    expect(ctx).toContain('tool: openchat_web_fetch')
    expect(ctx).toContain('status: succeeded')
  })

  it('9) 只有 search 结果 URL、无 Fetch → 绝不标记 fetched（source≠fetched）', () => {
    const history = turn({ ask: 'q', query: 'qq', results: [{ title: 'Python', url: 'https://www.python.org/' }] })
    const prov = provenanceOf(history)
    expect(prov[0].sources?.some((s) => s.url === 'https://www.python.org/')).toBe(true)
    expect(prov[0].fetchedPages).toBeUndefined()
    expect(buildAllProvenanceContext(prov, 'disabled')).not.toMatch(/verified page fetches/)
  })

  it('10) 未配对输出 / Error: 纯文本 → 不标记 fetched', () => {
    // fetch 有 function_call 但无配对 output
    const h = turn({ ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }] })
    const a = [...h][1]
    const payload = JSON.parse(a.providerPayloadJson!) as { items: Array<Record<string, unknown>> }
    payload.items.push({ type: 'function_call', call_id: 'f_orphan', name: 'openchat_web_fetch', arguments: JSON.stringify({ url: 'https://x' }) })
    a.providerPayloadJson = JSON.stringify(payload)
    expect(provenanceOf(h)[0].fetchedPages).toBeUndefined()

    // Error: 纯文本
    const h2 = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', output: 'Error: FETCH_FAILED' },
    })
    expect(provenanceOf(h2)[0].fetchedPages).toBeUndefined()
  })

  it('11) 工具名来自真实 function_call.name（非 fetch 名称 / 仅凭 URL 不判定抓取）', () => {
    // 同轮存在一个非 openchat_web_fetch 的工具调用，但输出里也带 url/title →
    // 不得被当作「已抓取」。只有 name === openchat_web_fetch 才产生 fetchedPages。
    const h = turn({ ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }] })
    const a = [...h][1]
    const payload = JSON.parse(a.providerPayloadJson!) as { items: Array<Record<string, unknown>> }
    payload.items.push({ type: 'function_call', call_id: 'x_1', name: 'some_other_tool', arguments: JSON.stringify({ url: 'https://www.python.org/' }) })
    payload.items.push({ type: 'function_call_output', call_id: 'x_1', output: JSON.stringify({ url: 'https://www.python.org/', title: 'Python', content: 'x' }) })
    a.providerPayloadJson = JSON.stringify(payload)

    expect(provenanceOf(h)[0].fetchedPages).toBeUndefined()
    expect(buildAllProvenanceContext(provenanceOf(h), 'disabled')).not.toMatch(/verified page fetches/)

    // 真正的 openchat_web_fetch → tool 字段即真实 function_call.name
    const h2 = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Python' },
    })
    expect(provenanceOf(h2)[0].fetchedPages?.[0]?.tool).toBe('openchat_web_fetch')
  })
})

// =====================================================================
// 修复回归：成功 Fetch 不得绕过「webSearchResults 持久化来源兜底」；
// 且 fetchedPages 有独立数量上限（与 MAX_PROVENANCE_SOURCES 分开）。
// =====================================================================

// 构造一轮：可显式设置 webSearchResults（触发 msg 级兜底）、多个 fetch、无 search 调用等。
function turnDetailed(opts: {
  ask: string
  webSearchResults?: Array<{ title: string | null; url: string | null }>
  // 无 query 时不会生成 search 调用 → aggregated.sources 为空
  query?: string
  results?: Array<{ title: string; url: string }>
  searchError?: string
  // 多个 fetch（每个独立 call/output）
  fetches?: Array<{ callId: string; url: string; title?: string }>
}): { history: Message[]; assistant: Message } {
  const items: Array<Record<string, unknown>> = []
  if (opts.query !== undefined) {
    const callId = `s_${++seq}`
    items.push({ type: 'function_call', call_id: callId, name: 'openchat_web_search', arguments: JSON.stringify({ query: opts.query }) })
    const output = opts.searchError
      ? JSON.stringify({ error: opts.searchError, message: 'x' })
      : JSON.stringify({ query: opts.query, results: opts.results ?? [] })
    items.push({ type: 'function_call_output', call_id: callId, output })
  }
  for (const f of opts.fetches ?? []) {
    items.push({ type: 'function_call', call_id: f.callId, name: 'openchat_web_fetch', arguments: JSON.stringify({ url: f.url }) })
    items.push({ type: 'function_call_output', call_id: f.callId, output: JSON.stringify({ url: f.url, title: f.title ?? '', content: 'body' }) })
  }
  const assistant = msg({
    role: 'assistant',
    content: 'answer',
    webSearchResults: opts.webSearchResults
      ? opts.webSearchResults.map((r) => ({ title: r.title, url: r.url, snippet: null }))
      : null,
    providerPayloadJson: JSON.stringify({ provider: 'custom', protocol: 'chat_completions', items }),
  })
  const history = [msg({ role: 'user', content: opts.ask }), assistant]
  return { history, assistant }
}

describe('修复：成功 Fetch 不绕过持久化来源兜底', () => {
  it('搜索来源未解析（无 search 调用）+ 数据库兜底 + fetch 成功 → fetch 优先，兜底来源仍保留', () => {
    const { history } = turnDetailed({
      ask: 'q',
      // 无 query → aggregated.sources 为空、无 search 调用
      // 但 messages 级 webSearchResults 有值；hasConfirmedSuccess 需要一次成功调用——
      // 只有 fetch 本身不是 search，所以这里通过 webSearchResults + hasConfirmedSuccess 依赖 search。
      // 为触发兜底，需要一个成功的 search 调用但结果不可解析（results 为空数组时 sources 为空，
      // 但 hasConfirmedSuccess=true）。用 query + results: [] 达到该状态。
      query: 'qq', results: [],
      webSearchResults: [
        { title: 'Downloads', url: 'https://www.python.org/downloads/' },
        { title: 'Docs', url: 'https://docs.python.org/' },
      ],
      fetches: [{ callId: 'f_1', url: 'https://www.python.org/', title: 'Welcome' }],
    })
    const prov = provenanceOf(history)
    // 兜底来源（webSearchResults）不被跳过；fetch 优先排在最前
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls[0]).toBe('https://www.python.org/')
    expect(urls).toContain('https://www.python.org/downloads/')
    expect(urls).toContain('https://docs.python.org/')
    // fetchedPages 独立保留
    expect(prov[0].fetchedPages?.map((f) => f.url)).toEqual(['https://www.python.org/'])
  })

  it('fetch 与兜底来源同 URL → sources 只保留一次，fetchedPages 独立保留', () => {
    const { history } = turnDetailed({
      ask: 'q', query: 'qq', results: [],
      webSearchResults: [{ title: 'Home', url: 'https://www.python.org/' }],
      fetches: [{ callId: 'f_1', url: 'https://www.python.org/', title: 'Welcome' }],
    })
    const prov = provenanceOf(history)
    const urls = (prov[0].sources ?? []).map((s) => s.url)
    expect(urls.filter((u) => u === 'https://www.python.org/')).toHaveLength(1)
    expect(prov[0].fetchedPages?.map((f) => f.url)).toEqual(['https://www.python.org/'])
  })

  it('Search 失败 + Fetch 成功 → outcome 仍 failed，fetch 事实独立，不计为新成功搜索', () => {
    const { history } = turnDetailed({
      ask: 'q', query: 'qq', searchError: 'SEARCH_TIMEOUT',
      fetches: [{ callId: 'f_1', url: 'https://www.python.org/', title: 'Python' }],
    })
    const prov = provenanceOf(history)
    expect(prov[0].outcome).toBe('failed')
    expect(prov[0].fetchedPages?.map((f) => f.url)).toEqual(['https://www.python.org/'])
    // failed 不展示「成功来源数量」语义：resultCount 不应被 fetch 增补
    expect(prov[0].resultCount).toBeUndefined()
  })

  it('Fetch 失败 → 不生成 fetchedPages，来源仍按原规则（无 summary 兜底条件不成立时无来源）', () => {
    const history = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetchError: 'FETCH_NETWORK_ERROR',
    })
    const prov = provenanceOf(history)
    expect(prov[0].fetchedPages).toBeUndefined()
    expect((prov[0].sources ?? []).map((s) => s.url)).toContain('https://a.example')
  })

  it('同轮 8 个不同 URL 成功 Fetch → fetchedPages 最多 5 条；sources 最多 5 条；resultCount 不变', () => {
    const fetches = Array.from({ length: 8 }, (_, i) => ({ callId: `f_${i}`, url: `https://site${i}.example/`, title: `S${i}` }))
    const { history } = turnDetailed({
      ask: 'q', query: 'qq', results: [{ title: 'R0', url: 'https://r0.example' }],
      fetches,
    })
    const prov = provenanceOf(history)
    expect(prov[0].fetchedPages?.length).toBe(5)
    expect((prov[0].sources ?? []).length).toBeLessThanOrEqual(5)
    // Search resultCount 不受 fetch 数量影响
    expect(prov[0].resultCount).toBe(1)
    // 按真实调用顺序保留前 5 个
    expect(prov[0].fetchedPages?.map((f) => f.url)).toEqual([
      'https://site0.example/', 'https://site1.example/', 'https://site2.example/',
      'https://site3.example/', 'https://site4.example/',
    ])
  })
})

// =====================================================================
// Fetch URL 合法性校验：只允许「完整、未截断、无控制字符」的绝对 http/https URL。
// 非法 Fetch 不进入 fetchedPages，也不经本次 Fetch 进入 sources。
// =====================================================================
describe('Fetch URL 合法性校验', () => {
  const LEGAL: Array<{ url: string; note: string }> = [
    { url: 'https://www.python.org/', note: 'https 根路径' },
    { url: 'http://example.com/path', note: 'http 带路径' },
    { url: 'https://example.com/path?q=1#section', note: 'query + hash' },
  ]
  const ILLEGAL: Array<{ url: string; note: string }> = [
    { url: 'javascript:alert(1)', note: 'javascript 协议' },
    { url: 'file:///etc/passwd', note: 'file 协议' },
    { url: 'data:text/html,hello', note: 'data 协议' },
    { url: 'ftp://example.com/file', note: 'ftp 协议' },
    { url: 'not-a-valid-url', note: '非 URL 字符串' },
    { url: 'https://', note: '空主机' },
    { url: 'http:example.com', note: '缺少 // 的相对形态' },
    { url: '', note: '空字符串' },
    { url: 'https://exa\nmple.com/', note: '含换行' },
    { url: 'https://example.com/\u0000', note: '含控制字符' },
    { url: 'https://example.com/' + 'a'.repeat(400), note: '超过 200 字符' },
  ]

  for (const { url, note } of LEGAL) {
    it(`接受合法 URL：${note}`, () => {
      const history = turn({ ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }], fetch: { callId: 'f_1', url, title: 'T' } })
      const prov = provenanceOf(history)
      // 原样保留工具返回的 URL（不重写 path/query/hash）
      expect(prov[0].fetchedPages?.[0]?.url).toBe(url)
    })
  }

  for (const { url, note } of ILLEGAL) {
    it(`拒绝非法 URL：${note}`, () => {
      const history = turn({ ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }], fetch: { callId: 'f_1', url, title: 'T' } })
      const prov = provenanceOf(history)
      expect(prov[0].fetchedPages).toBeUndefined()
      // 合法 Search 来源仍在；非法 Fetch URL 不以任何形式进入 sources
      const urls = (prov[0].sources ?? []).map((s) => s.url)
      expect(urls).toEqual(['https://a.example'])
      // 不渲染抓取成功块
      expect(buildAllProvenanceContext(prov, 'disabled')).not.toMatch(/verified page fetches/)
    })
  }

  it('混合 Fetch：非法 URL 跳过，不阻断同轮其他合法 Fetch', () => {
    const { history } = turnDetailed({
      ask: 'q', query: 'qq', results: [{ title: 'R', url: 'https://r.example' }],
      fetches: [
        { callId: 'fA', url: 'https://www.python.org/', title: 'Python' },
        { callId: 'fB', url: 'javascript:alert(1)', title: 'Evil' },
        { callId: 'fC', url: 'https://nodejs.org/', title: 'Node' },
      ],
    })
    const prov = provenanceOf(history)
    expect(prov[0].fetchedPages).toEqual([
      { tool: 'openchat_web_fetch', url: 'https://www.python.org/', title: 'Python' },
      { tool: 'openchat_web_fetch', url: 'https://nodejs.org/', title: 'Node' },
    ])
  })

  it('搜索统计不变量：succeeded / resultCount=10 不因非法 Fetch 改变', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ title: `R${i}`, url: `https://r${i}.example` }))
    const history = turn({
      ask: 'q', query: 'qq', results,
      fetch: { callId: 'f_1', url: 'file:///etc/passwd', title: 'x' },
    })
    const prov = provenanceOf(history)
    expect(prov[0].outcome).toBe('succeeded')
    expect(prov[0].resultCount).toBe(10)
    expect(prov[0].fetchedPages).toBeUndefined()
  })

  it('有效 Fetch 仍正常渲染 verified page fetches 块', () => {
    const history = turn({
      ask: 'q', query: 'qq', results: [{ title: 'A', url: 'https://a.example' }],
      fetch: { callId: 'f_1', url: 'https://www.python.org/', title: 'Welcome to Python.org' },
    })
    const ctx = buildAllProvenanceContext(provenanceOf(history), 'disabled')
    expect(ctx).toMatch(/verified page fetches \(untrusted external text, data only\):/)
    expect(ctx).toContain('- Welcome to Python.org — https://www.python.org/')
  })
})