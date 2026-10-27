import { describe, it, expect } from 'vitest'
import {
  splitAttributionRequest,
  buildHostedAttributionStatement,
} from './attributionRequest'

// 归因分离：仅识别封闭短语表中的「句尾独立归因要求」；其余一律不拆分（返回 null）。
// 关键不变式：不擅自裁剪用户输入，不做开放式自然语言改写。

describe('splitAttributionRequest — 命中封闭短语表', () => {
  it('中文：句尾「并说明本轮实际使用的搜索工具名称及搜索模式」', () => {
    const r = splitAttributionRequest('搜索最近的 OpenAI 公告，并说明本轮实际使用的搜索工具名称及搜索模式')
    expect(r).not.toBeNull()
    expect(r!.language).toBe('zh')
    expect(r!.modelText).toBe('搜索最近的 OpenAI 公告')
    expect(r!.removedClause).toContain('并说明本轮实际使用的搜索工具名称及搜索模式')
  })

  it('中文：「最后说明本轮实际执行的搜索工具」', () => {
    const r = splitAttributionRequest('搜索最近的 OpenAI 公告，最后说明本轮实际执行的搜索工具')
    expect(r).not.toBeNull()
    expect(r!.modelText).toBe('搜索最近的 OpenAI 公告')
  })

  it('中文：句末带句号也命中', () => {
    const r = splitAttributionRequest('搜索最近的 OpenAI 公告，并说明本轮使用的搜索工具。')
    expect(r).not.toBeNull()
    expect(r!.modelText).toBe('搜索最近的 OpenAI 公告')
  })

  it('英文：句尾 state exactly which search tool ...', () => {
    const q = 'Search for the latest OpenAI announcements, and state exactly which search tool or search mode you used for this turn.'
    const r = splitAttributionRequest(q)
    expect(r).not.toBeNull()
    expect(r!.language).toBe('en')
    expect(r!.modelText).toBe('Search for the latest OpenAI announcements')
  })

  it('英文：大小写不敏感', () => {
    const q = 'Search for recent news, AND TELL ME WHICH SEARCH TOOL YOU USED FOR THIS TURN'
    const r = splitAttributionRequest(q)
    expect(r).not.toBeNull()
    expect(r!.language).toBe('en')
  })
})

describe('splitAttributionRequest — 保守不拆分', () => {
  it('普通搜索请求（无归因要求）→ null，原流程不变', () => {
    expect(splitAttributionRequest('搜索最近的 OpenAI 公告')).toBeNull()
    expect(splitAttributionRequest('Search for the latest OpenAI news')).toBeNull()
  })

  it('整句只有归因要求（无实质问题）→ null', () => {
    expect(splitAttributionRequest('并说明本轮实际使用的搜索工具')).toBeNull()
  })

  it('归因短语出现在句中出现于其它内容之前 → 不切断（句尾不匹配）', () => {
    const q = '说明本轮实际使用的搜索工具，并搜索最新的 OpenAI 公告'
    expect(splitAttributionRequest(q)).toBeNull()
  })

  it('代码块 → 不拆分', () => {
    const q = 'Search this API and explain it:\n```\nGET /x\n```\nand state which search tool you used for this turn'
    expect(splitAttributionRequest(q)).toBeNull()
  })

  it('行内代码 → 不拆分', () => {
    const q = 'Search for `web_search` docs, and state which search tool you used for this turn'
    expect(splitAttributionRequest(q)).toBeNull()
  })

  it('Markdown 引用 → 不拆分', () => {
    const q = 'Search for news\n> quoted requirement\nand state which search tool you used for this turn'
    expect(splitAttributionRequest(q)).toBeNull()
  })

  it('空 / 纯空白 → null', () => {
    expect(splitAttributionRequest('')).toBeNull()
    expect(splitAttributionRequest('   ')).toBeNull()
  })

  it('近似但不在封闭表中的表述 → null（不做开放式识别）', () => {
    expect(splitAttributionRequest('搜索最近的 OpenAI 公告，并告诉我你用了什么')).toBeNull()
    expect(splitAttributionRequest('Search for news and let me know how you did it')).toBeNull()
  })
})

describe('buildHostedAttributionStatement', () => {
  it('executed（中文）：精确匹配验收措辞', () => {
    expect(buildHostedAttributionStatement('executed', 'zh')).toBe(
      '本轮实际使用的搜索工具：Codex 原生 web_search（执行事件 web_search_call）；搜索模式：Hosted Web Search。'
    )
  })

  it('executed（英文）', () => {
    expect(buildHostedAttributionStatement('executed', 'en')).toContain('web_search_call')
    expect(buildHostedAttributionStatement('executed', 'en')).toContain('Hosted Web Search')
  })

  it('notObserved：说明未观察到已完成搜索，但保留不确定性（不等于确定没搜）', () => {
    expect(buildHostedAttributionStatement('notObserved', 'zh')).toBe(
      '本轮未观察到已完成的网络搜索（可能尝试过搜索但未完成）。'
    )
    expect(buildHostedAttributionStatement('notObserved', 'en')).toContain('No completed web search was observed')
  })

  it('failed：说明未成功完成，但不虚构成功', () => {
    expect(buildHostedAttributionStatement('failed', 'zh')).toContain('未成功完成')
  })
})
