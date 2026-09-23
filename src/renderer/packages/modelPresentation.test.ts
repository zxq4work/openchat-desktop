import { describe, it, expect } from 'vitest'
import {
  visibleModels,
  humanizeReasoningEffort,
  reasoningEffortLabel,
  reasoningEffortOptions,
  resolveVisibleModel,
  resolveReasoningEffort,
  resolveNewConversationDefaults,
  shouldClearModelForNoVisible,
} from './modelPresentation'
import { modelSupportsImage } from './imageCapability'
import type { ModelInfo, SupportedReasoningEffort } from '../../shared/types/model'
import type { Conversation } from '../../shared/types/conversation'

const base = (id: string, hidden: boolean): ModelInfo => ({
  id,
  model: id,
  displayName: id,
  hidden,
  supportedReasoningEfforts: [],
})

describe('visibleModels', () => {
  it('filters out hidden models only', () => {
    const models = [base('a', false), base('b', true), base('c', false)]
    expect(visibleModels(models).map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('keeps all models when none are hidden (missing visibility = visible)', () => {
    const models = [base('a', false), base('b', false)]
    expect(visibleModels(models)).toHaveLength(2)
  })
})

describe('reasoningEffortLabel — 短名称只由 raw effort 生成', () => {
  // TEST 3-11：已知 effort 的稳定短名称映射
  it('TEST 3: low → Low', () => {
    expect(reasoningEffortLabel('low')).toBe('Low')
  })
  it('TEST 4: medium → Medium', () => {
    expect(reasoningEffortLabel('medium')).toBe('Medium')
  })
  it('TEST 5: high → High', () => {
    expect(reasoningEffortLabel('high')).toBe('High')
  })
  it('TEST 6: xhigh → Extra High', () => {
    expect(reasoningEffortLabel('xhigh')).toBe('Extra High')
  })
  it('TEST 7: max → Max', () => {
    expect(reasoningEffortLabel('max')).toBe('Max')
  })
  it('TEST 8: ultra → Ultra', () => {
    expect(reasoningEffortLabel('ultra')).toBe('Ultra')
  })
  it('TEST 9: persistent → Persistent', () => {
    expect(reasoningEffortLabel('persistent')).toBe('Persistent')
  })
  it('TEST 10: minimal → Minimal', () => {
    expect(reasoningEffortLabel('minimal')).toBe('Minimal')
  })
  it('TEST 11: none → None', () => {
    expect(reasoningEffortLabel('none')).toBe('None')
  })

  it('TEST 12: future_super_high → Future Super High', () => {
    expect(reasoningEffortLabel('future_super_high')).toBe('Future Super High')
  })

  it('TEST 13: future-super-high → Future Super High', () => {
    expect(reasoningEffortLabel('future-super-high')).toBe('Future Super High')
  })

  it('TEST 1: 长 description 不再作为主名称（medium → Medium）', () => {
    // 服务器对 medium 返回长 description，但短名称只由 effort 决定
    expect(reasoningEffortLabel('medium')).toBe('Medium')
    expect(reasoningEffortLabel('medium')).not.toBe('Balances speed and reasoning depth for everyday tasks')
  })
})

describe('humanizeReasoningEffort', () => {
  it('splits on underscores/dashes, collapses spaces, title-cases', () => {
    expect(humanizeReasoningEffort('future-level')).toBe('Future Level')
    expect(humanizeReasoningEffort('super-high')).toBe('Super High')
    expect(humanizeReasoningEffort('very_high_reasoning')).toBe('Very High Reasoning')
    expect(humanizeReasoningEffort('future_super_high')).toBe('Future Super High')
  })

  it('humanize 只影响展示名，option.value 始终是 raw effort（含连字符）', () => {
    const [opt] = reasoningEffortOptions([{ reasoningEffort: 'future-super-high' }])
    expect(opt.label).toBe('Future Super High')
    expect(opt.value).toBe('future-super-high')
  })
})

describe('reasoningEffortOptions — value 是 raw effort，description 仅作 tooltip', () => {
  const medium: SupportedReasoningEffort = {
    reasoningEffort: 'medium',
    description: 'Balances speed and reasoning depth for everyday tasks',
  }

  it('TEST 2: description 不成为 selected value（value = raw effort）', () => {
    const [opt] = reasoningEffortOptions([medium])
    expect(opt.value).toBe('medium')
    expect(opt.value).not.toBe('Medium')
    expect(opt.value).not.toBe(medium.description)
  })

  it('TEST 1: label 是短名称，description 单独保留', () => {
    const [opt] = reasoningEffortOptions([medium])
    expect(opt.label).toBe('Medium')
    expect(opt.description).toBe('Balances speed and reasoning depth for everyday tasks')
  })

  it('TEST 15: description 被完整保留', () => {
    const [opt] = reasoningEffortOptions([medium])
    expect(opt.description).toBe(medium.description)
  })

  it('TEST 14: 未知未来 effort 仍保留在选项中且原值透传', () => {
    const future: SupportedReasoningEffort[] = [
      { reasoningEffort: 'future_super_high', description: 'Experimental future reasoning mode' },
    ]
    const [opt] = reasoningEffortOptions(future)
    expect(opt.value).toBe('future_super_high')
    expect(opt.label).toBe('Future Super High')
    expect(opt.description).toBe('Experimental future reasoning mode')
  })

  it('unknown effort without description keeps undefined description', () => {
    const [opt] = reasoningEffortOptions([{ reasoningEffort: 'extreme' }])
    expect(opt.value).toBe('extreme')
    expect(opt.label).toBe('Extreme')
    expect(opt.description).toBeUndefined()
  })
})

describe('resolveVisibleModel — hidden / missing 当前模型 fallback', () => {
  const models = [base('A', false), base('B', true), base('C', false)]

  it('TEST P1-1: requested=B(hidden) → 第一个可见模型 A（绝不返回 hidden）', () => {
    expect(resolveVisibleModel(models, 'B')?.id).toBe('A')
  })

  it('TEST P1-2: requested 不存在 → first visible', () => {
    expect(resolveVisibleModel(models, 'gone')?.id).toBe('A')
    expect(resolveVisibleModel(models, null)?.id).toBe('A')
  })

  it('TEST P1-3: requested=C（visible）→ 保留 C', () => {
    expect(resolveVisibleModel(models, 'C')?.id).toBe('C')
  })

  it('TEST P1-4: 全部 hidden → null（绝不取 models[0]）', () => {
    const allHidden = [base('A', true), base('B', true)]
    expect(resolveVisibleModel(allHidden, 'A')).toBeNull()
    expect(resolveVisibleModel(allHidden, null)).toBeNull()
    expect(resolveVisibleModel([], 'A')).toBeNull()
  })

  it('TEST P1-5: saved default 变 hidden → 新建会话使用 first visible', () => {
    // saved default = B（现已 hidden），catalog 仍有 A/C
    expect(resolveVisibleModel(models, 'B')?.id).toBe('A')
  })

  it('TEST P1-6: active Codex conversation 当前 model hidden → fallback first visible', () => {
    const convModel = 'B' // 会话绑定的模型现已 hidden
    const resolved = resolveVisibleModel(models, convModel)
    expect(resolved?.id).toBe('A')
    expect(resolved?.hidden).toBe(false)
  })
})

describe('resolveReasoningEffort — 统一的 effort 归一化', () => {
  const withEfforts = (
    supported: string[],
    defaultEffort: string | null = null
  ): ModelInfo => ({
    ...base('m', false),
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: supported.map((reasoningEffort) => ({ reasoningEffort })),
  })

  it('TEST P3-1: supported=[low,medium,high], preferred=medium → medium', () => {
    expect(resolveReasoningEffort(withEfforts(['low', 'medium', 'high'], 'low'), 'medium')).toBe('medium')
  })

  it('TEST P3-2: preferred=ultra 不在 supported, default=medium → medium', () => {
    expect(resolveReasoningEffort(withEfforts(['low', 'medium', 'high'], 'medium'), 'ultra')).toBe('medium')
  })

  it('TEST P3-3: preferred=ultra, default=ultra（均不在 supported）→ supported[0]=low', () => {
    expect(resolveReasoningEffort(withEfforts(['low', 'medium', 'high'], 'ultra'), 'ultra')).toBe('low')
  })

  it('TEST P3-4: supported=[] + preferred=future_level → 保留 future_level（forward compat）', () => {
    expect(resolveReasoningEffort(withEfforts([], null), 'future_level')).toBe('future_level')
  })

  it('TEST P3-5: supported=[] + preferred=null + default=future_level → future_level', () => {
    expect(resolveReasoningEffort(withEfforts([], 'future_level'), null)).toBe('future_level')
  })

  it('TEST P3-6: supported=[] + preferred=null + default=null → null', () => {
    expect(resolveReasoningEffort(withEfforts([], null), null)).toBeNull()
  })

  it('TEST P3-7: supported=[future_super_high] + preferred=future_super_high → 原样保留（不被本地 enum 过滤）', () => {
    expect(resolveReasoningEffort(withEfforts(['future_super_high'], null), 'future_super_high')).toBe('future_super_high')
  })

  it('TEST P1-7: fallback 后 reasoning 按新 model 重新归一化（旧 ultra 不保留）', () => {
    // 旧模型 ultra → 新模型仅 [low,medium,high]，default=medium
    expect(resolveReasoningEffort(withEfforts(['low', 'medium', 'high'], 'medium'), 'ultra')).toBe('medium')
  })
})

describe('resolveNewConversationDefaults — provider 域隔离（Codex vs 自定义 Provider）', () => {
  const codexModels: ModelInfo[] = [
    { ...base('codex-a', false), supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' },
    { ...base('codex-hidden', true), supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { ...base('codex-c', false), supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
  ]

  it('TEST A: providerId=null + saved.modelId=hidden → fallback first visible', () => {
    const d = resolveNewConversationDefaults(codexModels, { providerId: null, modelId: 'codex-hidden', effort: 'high' })
    expect(d.modelId).toBe('codex-a')
    // effort 按实际模型归一化：high 不在 codex-a 支持集 → default medium
    expect(d.effort).toBe('medium')
  })

  it('TEST B: providerId=null + saved.modelId=visible → 保留', () => {
    const d = resolveNewConversationDefaults(codexModels, { providerId: null, modelId: 'codex-c', effort: 'high' })
    expect(d.modelId).toBe('codex-c')
    expect(d.effort).toBe('high')
  })

  it('TEST C: providerId="custom-1" + modelId="qwen-custom"（不在 Codex catalog）→ 原样保留，绝不 fallback Codex', () => {
    const d = resolveNewConversationDefaults(codexModels, { providerId: 'custom-1', modelId: 'qwen-custom', effort: 'high' })
    expect(d.modelId).toBe('qwen-custom')
    expect(d.modelId).not.toBe('codex-a')
    expect(codexModels.some((m) => m.id === d.modelId)).toBe(false)
  })

  it('TEST D: 自定义 Provider 下 effort 保持 saved.effort（不使用 Codex resolveReasoningEffort）', () => {
    const d = resolveNewConversationDefaults(codexModels, { providerId: 'custom-1', modelId: 'deepseek-x', effort: 'ultra' })
    expect(d.effort).toBe('ultra')
  })

  it('自定义 Provider + saved.modelId=null → 保持 null（不注入 Codex 模型）', () => {
    const d = resolveNewConversationDefaults(codexModels, { providerId: 'custom-1', modelId: null, effort: null })
    expect(d.modelId).toBeNull()
    expect(d.effort).toBeNull()
  })
})

describe('shouldClearModelForNoVisible — 全部 hidden 的清空判定', () => {
  const mixed: ModelInfo[] = [base('a', false), base('b', true)]
  const allHidden: ModelInfo[] = [base('a', true), base('b', true)]

  it('全部 hidden + 当前绑定 hidden id → 需要清空', () => {
    expect(shouldClearModelForNoVisible(allHidden, 'a')).toBe(true)
  })

  it('存在可见模型 → 不清空（走 fallback 路径）', () => {
    expect(shouldClearModelForNoVisible(mixed, 'b')).toBe(false)
  })

  it('当前已无模型（null）→ 不清空（已是目标态，避免重复写入）', () => {
    expect(shouldClearModelForNoVisible(allHidden, null)).toBe(false)
  })

  it('catalog 尚未加载（models 为空）→ 不清空（无法判断）', () => {
    expect(shouldClearModelForNoVisible([], 'a')).toBe(false)
  })
})

describe('image capability gate (input_modalities 三态)', () => {
  const conv = { providerConfigId: null, defaultModelId: 'gpt-6-astra' } as unknown as Conversation
  const modelWith = (inputModalities?: string[]): ModelInfo[] => [{
    id: 'gpt-6-astra',
    model: 'gpt-6-astra',
    displayName: 'GPT-6-Astra',
    hidden: false,
    supportedReasoningEfforts: [],
    ...(inputModalities === undefined ? {} : { inputModalities }),
  }]

  it('TEST 22: ["text","image"] → image allowed', () => {
    expect(modelSupportsImage(conv, modelWith(['text', 'image']), [])).toBe(true)
  })

  it('TEST 21: ["text"] → image blocked', () => {
    expect(modelSupportsImage(conv, modelWith(['text']), [])).toBe(false)
  })

  it('TEST 20: inputModalities omitted → legacy text+image compatibility（不阻止图片）', () => {
    expect(modelSupportsImage(conv, modelWith(undefined), [])).toBe(true)
  })

  it('[] → 明确空数组 → image blocked', () => {
    expect(modelSupportsImage(conv, modelWith([]), [])).toBe(false)
  })
})
