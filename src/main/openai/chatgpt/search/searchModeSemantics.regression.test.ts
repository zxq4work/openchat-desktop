import { describe, it, expect } from 'vitest'
import {
  CODEX_HOSTED_SEARCH_MODE_MARKER,
  CODEX_STANDALONE_SEARCH_MODE_MARKER,
  CODEX_SEARCH_INSTRUCTIONS,
  CODEX_STANDALONE_SEARCH_INSTRUCTIONS,
} from './codexSearchInstructions'
import { buildAllProvenanceContext, resolveAllSearchProvenance, type SearchProvenance } from './SearchProvenanceResolver'
import type { Message } from '../../../../shared/types/conversation'

// =====================================================================
// 回归：混合历史场景下的「当前工具」误报。
//
// 复现场景：此前一轮使用 Standalone（web.run）搜索；本轮使用 Hosted（provider-native
// web_search）搜索或天气服务。模型曾把「本轮」错误描述为 Standalone / web.run。
//
// 曾怀疑（未获证实）：Hosted 指令曾无条件叠加一段共享的搜索模式语义，其中正面描述了
// Standalone 工具 web.run。后续实验表明：完全移除该段后故障仍可复现，因此它**不是已证实
// 的根因**，只是加剧上下文混杂的一个因素。
//
// 当前取向：按搜索策略严格隔离指令 —— Hosted 只描述自身 provider-native web_search
// 与自我识别，不再出现 web.run / Standalone / namespace 归因；Standalone 反之。
// 历史来源仍如实保留（不改写、不删除），本文件后半段断言历史不被吞并。
// 注：本文件断言的是「指令按模式隔离」这一代码不变量，不代表已消除根因。
// =====================================================================

const standaloneMsg: Message = {
  id: 'm-standalone', conversationId: 'c1', segmentId: 's1', role: 'assistant', content: '旧回答',
  attachments: [], reasoningMeta: null, reasoningText: null, reasoningDisplayMode: 'none',
  webSearchResults: null, webSearchError: null, status: 'completed',
  modelId: null, reasoningEffort: null, providerTurnId: null, providerItemId: null,
  providerPayloadJson: JSON.stringify({
    provider: 'chatgpt_codex', protocol: 'chatgpt_codex',
    items: [
      { type: 'function_call', call_id: 'run-1', name: 'run', namespace: 'web', arguments: '{"search_query":[{"q":"旧查询"}]}' },
      { type: 'function_call_output', call_id: 'run-1', output: '旧结果' },
    ],
  }),
  errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1,
}

describe('混合历史 — 指令层严格隔离，当前工具不再被历史模式带偏', () => {
  it('Hosted 指令不含任何 Standalone 机制（指令隔离不变量）', () => {
    // 曾怀疑的污染源：Hosted 指令叠加了共享语义，正面描述 web.run 与 namespace 规则。
    // 该段移除后故障仍复现，故此处只断言「指令已隔离」，不主张根因已消除。
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('web.run')
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('namespace')
    expect(CODEX_SEARCH_INSTRUCTIONS).not.toContain('Standalone Web Search')
    // 仍携带自身模式标记与自我识别
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain(CODEX_HOSTED_SEARCH_MODE_MARKER)
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain('Hosted Web Search')
  })

  it('Standalone 指令不含任何 Hosted 归因，且携带自身模式标记', () => {
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).not.toContain('Hosted Web Search')
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toContain(CODEX_STANDALONE_SEARCH_MODE_MARKER)
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS).toContain('web.run')
  })

  it('不再有共享的搜索模式语义块被两侧同时叠加（避免同义叠加）', () => {
    // 两模式现在各自独立自我识别，互不引用对方机制
    expect(CODEX_SEARCH_INSTRUCTIONS.includes(CODEX_STANDALONE_SEARCH_MODE_MARKER)).toBe(false)
    expect(CODEX_STANDALONE_SEARCH_INSTRUCTIONS.includes(CODEX_HOSTED_SEARCH_MODE_MARKER)).toBe(false)
  })
})

describe('buildAllProvenanceContext — 历史列表不得冒充当前轮', () => {
  const pastStandalone: SearchProvenance = {
    mode: 'standalone', mechanism: 'web.run', queries: ['旧查询'], assistantMessageId: 'm-standalone',
  }

  it('历史来源被如实保留（不删除、不改写为 hosted）', () => {
    const ctx = buildAllProvenanceContext([pastStandalone], false)
    // 历史真相保留：standalone / web.run / 查询词
    expect(ctx).toContain('mode: standalone')
    expect(ctx).toContain('mechanism: web.run')
    expect(ctx).toContain('旧查询')
  })

  it('明确标注为「已完成的历史轮」，并声明最近条目属于更早一轮而非当前轮', () => {
    const ctx = buildAllProvenanceContext([pastStandalone], false)
    expect(ctx).toMatch(/PAST turns?/i)
    expect(ctx).toMatch(/never includes the search you perform in the current turn/i)
    // 关键：最近一条是「更早一轮」，不得据此判断当前轮模式
    expect(ctx).toMatch(/most recent entry above describes an EARLIER turn, NOT the current turn/i)
  })

  it('不再有「当前会话能力不覆盖这些历史事实」这类可能被误读为「历史决定当前模式」的表述', () => {
    const ctx = buildAllProvenanceContext([pastStandalone], false)
    expect(ctx).not.toMatch(/current session's search capability does NOT override/i)
  })

  it('混合历史解析：旧 Standalone 轮解析为 standalone（历史如实），但指令层要求当前轮以实际工具为准', () => {
    const resolved = resolveAllSearchProvenance([standaloneMsg])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ mode: 'standalone', mechanism: 'web.run' })
    // 该上下文注入后仍保留历史真相，同时新的语义指令已覆盖「当前执行优先」
    const ctx = buildAllProvenanceContext(resolved, false)
    expect(ctx).toContain('mode: standalone')
    // Hosted 指令以第一人称自我识别，不再需要从历史/反面例子推断
    expect(CODEX_SEARCH_INSTRUCTIONS).toContain('call it "Hosted Web Search"')
  })
})

describe('buildAllProvenanceContext — 三态当前能力说明（disabled / tools / presearch）', () => {
  const prov: SearchProvenance = {
    mode: 'custom', mechanism: 'openchat_web_search', queries: ['q'], assistantMessageId: 'm1',
    outcome: 'succeeded', resultCount: 1, sources: [{ title: 'T', url: 'https://e' }],
  }

  it('disabled → 明确「本轮无搜索工具」', () => {
    const ctx = buildAllProvenanceContext([prov], 'disabled')
    expect(ctx).toContain('no web search tool is provided for this turn')
    expect(ctx).not.toContain('web search is enabled for this turn')
  })

  it('tools → 明确「本轮可用搜索工具」', () => {
    const ctx = buildAllProvenanceContext([prov], 'tools')
    expect(ctx).toContain('a web search tool is available this turn')
  })

  it('presearch → 只陈述「搜索已开启、未暴露工具」，绝不推断本轮已搜索', () => {
    const ctx = buildAllProvenanceContext([prov], 'presearch')
    // 能力事实：开启 + 未向模型暴露工具
    expect(ctx).toContain('web search is enabled in OpenChat for this turn')
    expect(ctx).toContain('no web search tool is exposed to the model')
    // 绝不因「已开启」就宣称本轮已执行搜索（旧断言句式 "a search was ALREADY performed for you this turn"）
    expect(ctx).not.toMatch(/a search was ALREADY performed for you this turn/i)
    expect(ctx).toMatch(/must be determined ONLY from an explicit current-turn search execution notice/i)
    // 不得表述为「已关闭」
    expect(ctx).toMatch(/Do not describe web search as switched OFF or disabled/i)
    expect(ctx).not.toContain('no web search tool is provided for this turn')
    expect(ctx).not.toContain('they can enable web search')
    // 历史仍标注为过去轮
    expect(ctx).toMatch(/EARLIER turn, NOT the current turn/i)
  })

  it('布尔兼容：true→disabled，false→tools（既有调用方不受影响）', () => {
    expect(buildAllProvenanceContext([prov], true)).toBe(buildAllProvenanceContext([prov], 'disabled'))
    expect(buildAllProvenanceContext([prov], false)).toBe(buildAllProvenanceContext([prov], 'tools'))
    expect(buildAllProvenanceContext([prov])).toBe(buildAllProvenanceContext([prov], 'disabled'))
  })
})
