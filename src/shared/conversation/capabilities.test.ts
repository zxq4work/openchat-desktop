import { describe, it, expect } from 'vitest'
import {
  isChatProtocol,
  isImageProtocol,
  isProtocolCompatibleWithConversation,
  resolveConversationBinding,
  bindingBlockedMessage,
  invalidBindingLabel,
  canUseProviderModels,
  canEditImageParams,
  type BindingProviderLike,
} from './capabilities'

const chatProvider: BindingProviderLike = { id: 'p-chat', name: 'GPT Provider', protocol: 'chat_completions', models: ['gpt-5', 'gpt-4'] }
const responsesProvider: BindingProviderLike = { id: 'p-resp', name: 'OpenAI', protocol: 'responses', models: ['o4'] }
const imageProvider: BindingProviderLike = { id: 'p-img', name: 'Image Provider', protocol: 'image_generations', models: ['dall-e-3'] }

describe('protocol classification', () => {
  it('chat protocols', () => {
    expect(isChatProtocol('chat_completions')).toBe(true)
    expect(isChatProtocol('responses')).toBe(true)
    expect(isChatProtocol('chatgpt_codex')).toBe(true)
    expect(isChatProtocol('image_generations')).toBe(false)
    expect(isChatProtocol(null)).toBe(false)
  })

  it('image protocol', () => {
    expect(isImageProtocol('image_generations')).toBe(true)
    expect(isImageProtocol('chat_completions')).toBe(false)
  })

  it('compatibility by conversation type never lets provider override modality', () => {
    expect(isProtocolCompatibleWithConversation('chat_completions', 'chat')).toBe(true)
    expect(isProtocolCompatibleWithConversation('image_generations', 'chat')).toBe(false)
    expect(isProtocolCompatibleWithConversation('image_generations', 'image_generation')).toBe(true)
    expect(isProtocolCompatibleWithConversation('chat_completions', 'image_generation')).toBe(false)
    expect(isProtocolCompatibleWithConversation('responses', 'image_generation')).toBe(false)
  })
})

describe('resolveConversationBinding', () => {
  it('chat + chat provider => valid', () => {
    const r = resolveConversationBinding({ conversationType: 'chat', providerConfigId: 'p-chat', modelId: 'gpt-5', providers: [chatProvider] })
    expect(r.status).toBe('valid')
    expect(r.provider?.id).toBe('p-chat')
  })

  it('chat + image provider => provider_incompatible (conversation stays chat)', () => {
    const r = resolveConversationBinding({ conversationType: 'chat', providerConfigId: 'p-img', modelId: 'dall-e-3', providers: [imageProvider] })
    expect(r.status).toBe('provider_incompatible')
    expect(r.provider?.id).toBe('p-img')
  })

  it('image + image provider => valid', () => {
    const r = resolveConversationBinding({ conversationType: 'image_generation', providerConfigId: 'p-img', modelId: 'dall-e-3', providers: [imageProvider] })
    expect(r.status).toBe('valid')
  })

  it('image + chat provider => provider_incompatible', () => {
    const r = resolveConversationBinding({ conversationType: 'image_generation', providerConfigId: 'p-chat', modelId: 'gpt-5', providers: [chatProvider] })
    expect(r.status).toBe('provider_incompatible')
  })

  it('provider missing => provider_missing', () => {
    const r = resolveConversationBinding({ conversationType: 'chat', providerConfigId: 'gone', modelId: 'gpt-5', providers: [chatProvider] })
    expect(r.status).toBe('provider_missing')
    expect(r.provider).toBeNull()
  })

  it('model missing => model_missing', () => {
    const r = resolveConversationBinding({ conversationType: 'chat', providerConfigId: 'p-chat', modelId: 'removed-model', providers: [chatProvider] })
    expect(r.status).toBe('model_missing')
    expect(r.provider?.id).toBe('p-chat')
  })

  it('no provider bound => unconfigured, not an error', () => {
    expect(resolveConversationBinding({ conversationType: 'chat', providerConfigId: null, modelId: null, providers: [] }).status).toBe('unconfigured')
    expect(resolveConversationBinding({ conversationType: 'image_generation', providerConfigId: null, modelId: null, providers: [] }).status).toBe('unconfigured')
  })

  it('responses provider is chat-compatible', () => {
    const r = resolveConversationBinding({ conversationType: 'chat', providerConfigId: 'p-resp', modelId: 'o4', providers: [responsesProvider] })
    expect(r.status).toBe('valid')
  })
})

describe('bindingBlockedMessage', () => {
  it('never claims the conversation is locked to image generation', () => {
    const msg = bindingBlockedMessage('provider_incompatible', 'chat')
    expect(msg).toContain('聊天会话')
    expect(msg).not.toContain('锁定')
    expect(msg).not.toContain('图片生成类型')
  })

  it('image conversation reports image semantics', () => {
    expect(bindingBlockedMessage('provider_incompatible', 'image_generation')).toContain('图片生成会话')
    expect(bindingBlockedMessage('provider_missing', 'image_generation')).toContain('图片供应商')
  })

  it('provider missing / model missing wording', () => {
    expect(bindingBlockedMessage('provider_missing', 'chat')).toContain('原聊天供应商已不可用')
    expect(bindingBlockedMessage('model_missing', 'chat')).toContain('原模型已不可用')
  })
})

describe('invalidBindingLabel', () => {
  it('provider_incompatible: chat conversation vs image conversation', () => {
    expect(invalidBindingLabel({ status: 'provider_incompatible', conversationType: 'chat', providerName: 'GPT Provider', modelName: 'gpt-5' }))
      .toBe('GPT Provider（已改为图片生成）')
    expect(invalidBindingLabel({ status: 'provider_incompatible', conversationType: 'image_generation', providerName: 'Image Provider', modelName: 'dall-e-3' }))
      .toBe('Image Provider（已改为聊天协议）')
  })

  it('provider_missing uses snapshot name, else fallback text', () => {
    expect(invalidBindingLabel({ status: 'provider_missing', conversationType: 'chat', providerName: 'DeepSeek', modelName: null }))
      .toBe('DeepSeek（供应商已删除）')
    expect(invalidBindingLabel({ status: 'provider_missing', conversationType: 'chat', providerName: null, modelName: null }))
      .toBe('原供应商已删除')
  })

  it('model_missing', () => {
    expect(invalidBindingLabel({ status: 'model_missing', conversationType: 'chat', providerName: 'DeepSeek', modelName: 'V3' }))
      .toBe('DeepSeek / V3（模型已不可用）')
  })
})

// canUseProviderModels：Provider 层失效 vs Model 层失效的区分（Select 是否可用其 models 的唯一判据）。
// 这是 ModelSelector / ImageComposer 共用逻辑，直接决定会不会错误掉进 Codex 列表或泄露聊天模型。
describe('canUseProviderModels (provider-layer vs model-layer failure)', () => {
  it('valid / unconfigured / model_missing → usable (provider itself is fine)', () => {
    expect(canUseProviderModels(chatProvider, 'valid')).toBe(true)
    expect(canUseProviderModels(chatProvider, 'unconfigured')).toBe(true)
    expect(canUseProviderModels(chatProvider, 'model_missing')).toBe(true)
  })

  it('provider_missing / provider_incompatible → NOT usable', () => {
    expect(canUseProviderModels(imageProvider, 'provider_missing')).toBe(false)
    expect(canUseProviderModels(chatProvider, 'provider_incompatible')).toBe(false)
  })

  it('no provider or no status → NOT usable', () => {
    expect(canUseProviderModels(null, 'valid')).toBe(false)
    expect(canUseProviderModels(chatProvider, null)).toBe(false)
  })
})

// canEditImageParams：图片参数（size/quality/background/outputFormat）可编辑性。
// 只有 binding 完全 valid 才能改；其余一律禁止 —— 尤其 provider_incompatible，
// 此时 Provider 协议已改成 chat，但 DB 仍可能残留旧 image_generation_profile_json。
describe('canEditImageParams (image params editable only when binding fully valid)', () => {
  it('valid => editable', () => {
    expect(canEditImageParams('valid')).toBe(true)
  })

  it('model_missing / provider_missing / provider_incompatible / unconfigured => NOT editable', () => {
    expect(canEditImageParams('model_missing')).toBe(false)
    expect(canEditImageParams('provider_missing')).toBe(false)
    expect(canEditImageParams('provider_incompatible')).toBe(false)
    expect(canEditImageParams('unconfigured')).toBe(false)
  })

  it('null / undefined status => NOT editable', () => {
    expect(canEditImageParams(null)).toBe(false)
    expect(canEditImageParams(undefined)).toBe(false)
  })

  it('provider switched to chat ⇒ incompatible ⇒ params locked even though profile json may remain', () => {
    const providerAsChat: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['gpt-5'] }
    const binding = resolveConversationBinding({
      conversationType: 'image_generation',
      providerConfigId: 'A',
      modelId: 'dall-e-3',
      providers: [providerAsChat],
    })
    expect(binding.status).toBe('provider_incompatible')
    expect(canEditImageParams(binding.status)).toBe(false)
    // 恢复 image 协议后同一组 ID 自动恢复 valid → 参数重新可编辑
    const providerAsImage: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'image_generations', models: ['dall-e-3'] }
    const recovered = resolveConversationBinding({
      conversationType: 'image_generation',
      providerConfigId: 'A',
      modelId: 'dall-e-3',
      providers: [providerAsImage],
    })
    expect(recovered.status).toBe('valid')
    expect(canEditImageParams(recovered.status)).toBe(true)
  })
})

describe('Case A: custom chat provider + model_missing', () => {
  it('keeps the provider bound, proves its models are usable, no Codex fallback', () => {
    // Provider A 仍是 chat 协议，只是原 modelId(old) 不在 models 中
    const providerA: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['m1', 'm2'] }
    const binding = resolveConversationBinding({
      conversationType: 'chat',
      providerConfigId: 'A',
      modelId: 'old',
      providers: [providerA],
    })
    expect(binding.status).toBe('model_missing')
    // Provider 仍然解析出来，且它的 models 依然可用 → 必须继续展示 m1 / m2
    expect(binding.provider?.id).toBe('A')
    expect(canUseProviderModels(binding.provider, binding.status)).toBe(true)
    // synthetic 旧模型标签可用
    expect(invalidBindingLabel({ status: binding.status, conversationType: 'chat', providerName: 'Provider A', modelName: 'old' }))
      .toBe('Provider A / old（模型已不可用）')
  })

  it('Case B: selecting m1 makes binding valid again, providerConfigId untouched', () => {
    const providerA: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['m1', 'm2'] }
    // 用户选择 m1 → 会话仅更新 modelId，providerConfigId 保持 A
    const conv = { conversationType: 'chat' as const, providerConfigId: 'A', modelId: 'm1' }
    const binding = resolveConversationBinding({ ...conv, providers: [providerA] })
    expect(binding.status).toBe('valid')
    expect(binding.provider?.id).toBe('A')
    expect(conv.providerConfigId).toBe('A')
  })
})

describe('Case C/D: image conversation provider-layer vs model-layer failure', () => {
  it('Case C: provider switched to chat → provider_incompatible, models NOT usable (no chat models leak)', () => {
    // Provider A 原为 image_generations，现改成 chat_completions，其 models 已是聊天模型
    const providerAsChat: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['gpt-5', 'gpt-4'] }
    const binding = resolveConversationBinding({
      conversationType: 'image_generation',
      providerConfigId: 'A',
      modelId: 'dall-e-3',
      providers: [providerAsChat],
    })
    expect(binding.status).toBe('provider_incompatible')
    // provider 仍被解析用于展示名称，但 models 绝不可用
    expect(binding.provider?.id).toBe('A')
    expect(canUseProviderModels(binding.provider, binding.status)).toBe(false)
  })

  it('Case D: image provider intact but original model gone → model_missing, remaining image models usable', () => {
    const imageProvider2: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'image_generations', models: ['image-model-2'] }
    const binding = resolveConversationBinding({
      conversationType: 'image_generation',
      providerConfigId: 'A',
      modelId: 'removed-image-model',
      providers: [imageProvider2],
    })
    expect(binding.status).toBe('model_missing')
    expect(canUseProviderModels(binding.provider, binding.status)).toBe(true)
    expect(binding.provider?.models).toEqual(['image-model-2'])
  })
})

// 动态恢复：binding 状态必须完全由「当前保存的 providerId/modelId + 当前 registry」推导，
// 与任何历史 invalid 状态无关。以下测试模拟 registry 连续变化，验证同一组 ID 自动恢复。
describe('dynamic recovery (binding is derived, never stored)', () => {
  const convChatA = { conversationType: 'chat' as const, providerConfigId: 'A', modelId: 'model-A' }

  it('Case 1: provider chat → image → chat recovers without clearing ids', () => {
    const asChat: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['model-A'] }
    const asImage: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'image_generations', models: ['model-A'] }

    // 初始：chat
    expect(resolveConversationBinding({ ...convChatA, providers: [asChat] }).status).toBe('valid')
    // 改为 image：同一 providerId，会话仍是 chat → incompatible
    const broken = resolveConversationBinding({ ...convChatA, providers: [asImage] })
    expect(broken.status).toBe('provider_incompatible')
    // 会话保存的 ID 从未被触碰（resolve 是纯函数，不返回值即不改）
    expect(convChatA.providerConfigId).toBe('A')
    expect(convChatA.modelId).toBe('model-A')
    // 改回 chat：无需用户改绑 → 自动恢复 valid，原 providerId/modelId 仍有效
    const recovered = resolveConversationBinding({ ...convChatA, providers: [asChat] })
    expect(recovered.status).toBe('valid')
    expect(recovered.provider?.id).toBe('A')
    expect(recovered.modelId).toBe('model-A')
  })

  it('Case 2: user re-binds to B during invalid; A recovery does not switch back', () => {
    const asChat: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['model-A'] }
    const asImage: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'image_generations', models: ['model-A'] }
    const providerB: BindingProviderLike = { id: 'B', name: 'Provider B', protocol: 'chat_completions', models: ['model-B'] }

    expect(resolveConversationBinding({ ...convChatA, providers: [asImage] }).status).toBe('provider_incompatible')
    // 用户明确改绑到 B → conversation 更新为 B / model-B（这是显式选择的结果，不是自动发生的）
    const rebound = { conversationType: 'chat' as const, providerConfigId: 'B', modelId: 'model-B' }
    expect(resolveConversationBinding({ ...rebound, providers: [asChat, providerB] }).status).toBe('valid')
    // A 之后恢复 chat：绑定仍指向 B，A 的恢复不影响当前 binding
    const afterA = resolveConversationBinding({ ...rebound, providers: [asChat, providerB] })
    expect(afterA.provider?.id).toBe('B')
    expect(afterA.modelId).toBe('model-B')
  })

  it('Case 3: model disappears then same id returns → valid → model_missing → valid', () => {
    const withX: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['model-X'] }
    const withoutX: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['model-Y'] }

    const conv = { conversationType: 'chat' as const, providerConfigId: 'A', modelId: 'model-X' }
    expect(resolveConversationBinding({ ...conv, providers: [withX] }).status).toBe('valid')
    expect(resolveConversationBinding({ ...conv, providers: [withoutX] }).status).toBe('model_missing')
    // model-X 同 ID 重新出现 → 自动恢复
    expect(resolveConversationBinding({ ...conv, providers: [withX] }).status).toBe('valid')
    // modelId 从未被清空
    expect(conv.modelId).toBe('model-X')
  })

  it('Case 4: same display name but different id does NOT auto-recover', () => {
    // 原 modelId = X，registry 现在只有 Y（即使展示名相同）
    const conv = { conversationType: 'chat' as const, providerConfigId: 'A', modelId: 'model-X' }
    const withY: BindingProviderLike = { id: 'A', name: 'Provider A', protocol: 'chat_completions', models: ['model-Y'] }
    // 名称是显示层的事，binding 只看 ID → 仍为 model_missing
    expect(resolveConversationBinding({ ...conv, providers: [withY] }).status).toBe('model_missing')
  })

  it('Case 8: image conversation recovery mirrors chat behavior', () => {
    const imageOk: BindingProviderLike = { id: 'I', name: 'Image Provider', protocol: 'image_generations', models: ['dall-e-3'] }
    const imageAsChat: BindingProviderLike = { id: 'I', name: 'Image Provider', protocol: 'chat_completions', models: ['dall-e-3'] }
    const conv = { conversationType: 'image_generation' as const, providerConfigId: 'I', modelId: 'dall-e-3' }

    expect(resolveConversationBinding({ ...conv, providers: [imageOk] }).status).toBe('valid')
    expect(resolveConversationBinding({ ...conv, providers: [imageAsChat] }).status).toBe('provider_incompatible')
    expect(resolveConversationBinding({ ...conv, providers: [imageOk] }).status).toBe('valid')
    expect(conv.providerConfigId).toBe('I')
  })
})
