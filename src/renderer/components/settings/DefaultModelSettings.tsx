import React, { useEffect, useState, useRef } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'
import { EFFORT_LABELS } from '../../../shared/constants'
import { Dropdown } from '../Dropdown'

const DEFAULT_PROVIDER_VALUE = '__openchat_default__'

const CUSTOM_REASONING_EFFORTS = [
  { reasoningEffort: 'none', description: 'No reasoning' },
  { reasoningEffort: 'minimal', description: 'Minimal reasoning' },
  { reasoningEffort: 'low', description: 'Low reasoning' },
  { reasoningEffort: 'medium', description: 'Medium reasoning' },
  { reasoningEffort: 'high', description: 'High reasoning' },
  { reasoningEffort: 'xhigh', description: 'Extra high reasoning' },
]

interface DefaultModelState {
  providerId: string | null
  modelId: string | null
  effort: string | null
}

export function DefaultModelSettings() {
  const models = useModelStore((s) => s.models)
  const providers = useProviderStore((s) => s.providers)

  const [defaults, setDefaults] = useState<DefaultModelState>({
    providerId: null,
    modelId: null,
    effort: null,
  })
  const [loaded, setLoaded] = useState(false)
  const defaultsRef = useRef(defaults)

  useEffect(() => {
    window.openchat.settings.getDefaultModel().then((d) => {
      if (d) {
        const next = {
          providerId: d.providerId ?? null,
          modelId: d.modelId ?? null,
          effort: d.effort ?? null,
        }
        setDefaults(next)
        defaultsRef.current = next
      }
    }).catch((err) => {
      console.error('[DefaultModelSettings] load failed:', err)
    }).finally(() => {
      setLoaded(true)
    })
  }, [])

  const doSave = (next: DefaultModelState) => {
    window.openchat.settings.setDefaultModel(next.providerId, next.modelId, next.effort)
  }

  // 当前提供商
  const currentProviderId = defaults.providerId ?? DEFAULT_PROVIDER_VALUE
  const isCustomProvider = currentProviderId !== DEFAULT_PROVIDER_VALUE
  const currentProvider = isCustomProvider
    ? providers.find((p) => p.id === currentProviderId)
    : null

  // 模型选项
  const modelOptions = isCustomProvider
    ? (currentProvider?.models ?? []).map((m) => ({ value: m, label: m }))
    : models.filter((m) => !m.hidden).map((m) => ({ value: m.id, label: m.displayName }))

  // 推理强度选项
  const currentModelId = defaults.modelId
  const currentModel = isCustomProvider ? null : models.find((m) => m.id === currentModelId)
  const effortOptions = isCustomProvider
    ? CUSTOM_REASONING_EFFORTS
    : (currentModel?.supportedReasoningEfforts ?? [])

  const handleProviderChange = (value: string) => {
    if (value === DEFAULT_PROVIDER_VALUE) {
      // 切换回 ChatGPT Codex，使用 models[0] 作为默认
      const firstModel = models.length > 0 ? models[0] : null
      const firstEffort = firstModel?.defaultReasoningEffort
        ?? firstModel?.supportedReasoningEfforts[0]?.reasoningEffort
        ?? null
      const next = { providerId: null, modelId: firstModel?.id ?? null, effort: firstEffort }
      setDefaults(next)
      defaultsRef.current = next
      doSave(next)
    } else {
      const provider = providers.find((p) => p.id === value)
      const firstModel = provider?.models?.[0] ?? null
      const next = { providerId: value, modelId: firstModel, effort: null }
      setDefaults(next)
      defaultsRef.current = next
      doSave(next)
    }
  }

  const handleModelChange = (modelId: string) => {
    if (isCustomProvider) {
      const next = { ...defaultsRef.current, modelId }
      setDefaults(next)
      defaultsRef.current = next
      doSave(next)
    } else {
      const model = models.find((m) => m.id === modelId)
      const supported = model?.supportedReasoningEfforts.map((e) => e.reasoningEffort) ?? []
      let newEffort = defaultsRef.current.effort
      if (newEffort && !supported.includes(newEffort)) {
        newEffort = model?.defaultReasoningEffort ?? supported[0] ?? null
      }
      const next = { ...defaultsRef.current, modelId, effort: newEffort }
      setDefaults(next)
      defaultsRef.current = next
      doSave(next)
    }
  }

  const handleEffortChange = (effort: string) => {
    const next = { ...defaultsRef.current, effort }
    setDefaults(next)
    defaultsRef.current = next
    doSave(next)
  }

  if (!loaded) return null

  const providerOptions = [
    { value: DEFAULT_PROVIDER_VALUE, label: 'ChatGPT Codex' },
    ...providers.map((p: SafeProviderConfig) => ({ value: p.id, label: p.name })),
  ]

  return (
    <div className="default-model-settings">
      <div className="default-model-row">
        <label className="default-model-label">服务</label>
        <Dropdown
          className="default-model-dropdown"
          value={currentProviderId}
          placeholder="选择服务"
          options={providerOptions}
          onChange={handleProviderChange}
          ariaLabel="选择默认服务"
        />
      </div>
      <div className="default-model-row">
        <label className="default-model-label">模型</label>
        <Dropdown
          className="default-model-dropdown"
          value={defaults.modelId ?? ''}
          placeholder="（无）"
          options={modelOptions}
          onChange={handleModelChange}
          ariaLabel="选择默认模型"
        />
      </div>
      {effortOptions.length > 0 && (
        <div className="default-model-row">
          <label className="default-model-label">推理强度</label>
          <Dropdown
            className="default-model-dropdown"
            value={defaults.effort ?? ''}
            placeholder="（无）"
            options={effortOptions.map((e) => ({
              value: e.reasoningEffort,
              label: EFFORT_LABELS[e.reasoningEffort] ?? e.reasoningEffort,
            }))}
            onChange={handleEffortChange}
            ariaLabel="选择默认推理强度"
          />
        </div>
      )}
      <p className="default-model-hint">新会话将自动应用以上设置</p>
    </div>
  )
}