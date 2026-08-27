import React, { useState, useEffect, useRef } from 'react'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'
import { Dropdown } from '../Dropdown'

const PROTOCOL_OPTIONS = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
]

const TOOL_CALLING_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'enabled', label: '开启' },
  { value: 'disabled', label: '关闭' },
]

const PROTOCOL_LABELS: Record<string, string> = Object.fromEntries(
  PROTOCOL_OPTIONS.map((o) => [o.value, o.label])
)

const TOOL_CALLING_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_CALLING_OPTIONS.map((o) => [o.value, o.label])
)

interface ProviderFormDialogProps {
  editId: string | null
  initialName: string
  initialProtocol: 'chat_completions' | 'responses'
  initialBaseUrl: string
  initialApiKey: string
  initialModels: string[]
  initialToolCalling: 'auto' | 'enabled' | 'disabled'
  onSave: () => void
  onClose: () => void
}

function ProviderFormDialog(props: ProviderFormDialogProps) {
  const [name, setName] = useState(props.initialName)
  const [protocol, setProtocol] = useState<'chat_completions' | 'responses'>(props.initialProtocol)
  const [baseUrl, setBaseUrl] = useState(props.initialBaseUrl)
  const [apiKey, setApiKey] = useState(props.initialApiKey)
  const [models, setModels] = useState<string[]>([...props.initialModels])
  const [newModelInput, setNewModelInput] = useState('')
  const [toolCalling, setToolCalling] = useState<'auto' | 'enabled' | 'disabled'>(props.initialToolCalling)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)

  function addModel() {
    const trimmed = newModelInput.trim()
    if (!trimmed) return
    if (models.includes(trimmed)) return
    setModels([...models, trimmed])
    setNewModelInput('')
  }

  function removeModel(index: number) {
    setModels(models.filter((_, i) => i !== index))
  }

  function handleModelInputKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      addModel()
    }
  }

  async function handleFetchModels() {
    if (!baseUrl.trim()) return
    setFetchingModels(true)
    setFetchError('')
    try {
      const fetchedModels = await window.openchat.providers.fetchModels(
        baseUrl.trim(),
        apiKey.trim(),
        undefined,
        props.editId ?? undefined
      )
      if (fetchedModels.length === 0) {
        setFetchError('未获取到模型，请检查 API 地址和 Key')
      } else {
        const existing = new Set(models)
        for (const m of fetchedModels) {
          if (!existing.has(m)) {
            models.push(m)
            existing.add(m)
          }
        }
        setModels([...models])
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err))
    } finally {
      setFetchingModels(false)
    }
  }

  async function handleSave() {
    if (!name.trim() || !baseUrl.trim()) return

    if (props.editId) {
      const updates: Record<string, unknown> = {
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        models,
        toolCalling,
      }
      if (apiKey.trim()) {
        updates.apiKey = apiKey.trim()
      }
      await window.openchat.providers.update(props.editId, updates)
    } else {
      if (!apiKey.trim()) return
      await window.openchat.providers.create({
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models,
        toolCalling,
      })
    }
    props.onSave()
  }

  return (
    <div
      className="dialog-overlay"
      ref={overlayRef}
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) props.onClose()
      }}
    >
      <div className="dialog provider-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{props.editId ? '编辑模型服务' : '添加模型服务'}</h3>

        <div className="provider-form-field">
          <label className="provider-label">名称</label>
          <input
            className="provider-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的 DeepSeek"
          />
        </div>

        <div className="provider-form-field">
          <label className="provider-label">协议</label>
          <Dropdown
            className="provider-dropdown"
            value={protocol}
            options={PROTOCOL_OPTIONS}
            onChange={(value) => setProtocol(value as 'chat_completions' | 'responses')}
            ariaLabel="选择协议"
          />
        </div>

        <div className="provider-form-field">
          <label className="provider-label">API Base URL</label>
          <input
            className="provider-input"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </div>

        <div className="provider-form-field">
          <label className="provider-label">API Key</label>
          <input
            className="provider-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={props.editId ? '留空则不修改' : 'sk-...'}
          />
        </div>

        <div className="provider-form-field">
          <label className="provider-label">模型列表</label>
          <div className="provider-model-input-row">
            <input
              className="provider-input"
              type="text"
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={handleModelInputKeyDown}
              placeholder="输入模型 ID 后按回车或点击添加"
            />
            <button
              className="provider-model-add-btn"
              onClick={addModel}
              disabled={!newModelInput.trim() || models.includes(newModelInput.trim())}
            >
              添加
            </button>
          </div>
          <div className="provider-model-fetch-row">
            <button
              className="provider-model-fetch-btn"
              onClick={handleFetchModels}
              disabled={fetchingModels || !baseUrl.trim() || (!apiKey.trim() && !props.editId)}
            >
              {fetchingModels ? '获取中...' : '从 API 获取模型列表'}
            </button>
          </div>
          {fetchError && (
            <p className="provider-model-fetch-error">{fetchError}</p>
          )}
          {models.length > 0 && (
            <div className="provider-model-tags">
              {models.map((m, i) => (
                <span key={`${m}-${i}`} className="provider-model-tag">
                  {m}
                  <button
                    className="provider-model-tag-remove"
                    onClick={() => removeModel(i)}
                    aria-label={`移除 ${m}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {models.length === 0 && (
            <p className="provider-hint">暂未添加模型，可手动输入或点击"从 API 获取"自动拉取</p>
          )}
        </div>

        <div className="provider-form-field">
          <label className="provider-label">Tools</label>
          <Dropdown
            className="provider-dropdown"
            value={toolCalling}
            options={TOOL_CALLING_OPTIONS}
            onChange={(value) => setToolCalling(value as 'auto' | 'enabled' | 'disabled')}
            ariaLabel="选择 Tools 模式"
          />
        </div>

        <div className="dialog-actions">
          <button className="btn-cancel" onClick={props.onClose}>取消</button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!name.trim() || !baseUrl.trim()}
          >
            {props.editId ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProviderSettings() {
  const providers = useProviderStore((s) => s.providers)
  const setProviders = useProviderStore((s) => s.setProviders)

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [dialogInitial, setDialogInitial] = useState({
    name: '',
    protocol: 'chat_completions' as 'chat_completions' | 'responses',
    baseUrl: '',
    apiKey: '',
    models: [] as string[],
    toolCalling: 'auto' as 'auto' | 'enabled' | 'disabled',
  })

  useEffect(() => {
    loadProviders()
  }, [])

  async function loadProviders() {
    const list = await window.openchat.providers.list()
    setProviders(list as SafeProviderConfig[])
  }

  function openAddDialog() {
    setEditId(null)
    setDialogInitial({ name: '', protocol: 'chat_completions', baseUrl: '', apiKey: '', models: [], toolCalling: 'auto' })
    setDialogOpen(true)
  }

  function openEditDialog(p: SafeProviderConfig) {
    setEditId(p.id)
    setDialogInitial({
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: '',
      models: [...p.models],
      toolCalling: p.toolCalling,
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    setDialogOpen(false)
    await loadProviders()
  }

  async function handleDelete(id: string) {
    await window.openchat.providers.delete(id)
    await loadProviders()
  }

  return (
    <div className="provider-settings">
      <div className="provider-settings-header">
        <h4>模型服务</h4>
        <button className="provider-add-btn" onClick={openAddDialog}>
          + 添加
        </button>
      </div>

      {dialogOpen && (
        <ProviderFormDialog
          editId={editId}
          initialName={dialogInitial.name}
          initialProtocol={dialogInitial.protocol}
          initialBaseUrl={dialogInitial.baseUrl}
          initialApiKey={dialogInitial.apiKey}
          initialModels={dialogInitial.models}
          initialToolCalling={dialogInitial.toolCalling}
          onSave={handleSave}
          onClose={() => setDialogOpen(false)}
        />
      )}

      {providers.length > 0 && (
        <div className="provider-list">
          {providers.map((p) => (
            <div key={p.id} className="provider-card">
              <div className="provider-card-header">
                <span className="provider-card-name">{p.name}</span>
                <span className={`provider-card-badge provider-card-badge--${p.protocol}`}>{PROTOCOL_LABELS[p.protocol] ?? p.protocol}</span>
              </div>
              <div className="provider-card-meta">
                <span className="provider-card-url">{p.baseUrl}</span>
                <span className="provider-card-tool-mode">Tools: {TOOL_CALLING_LABELS[p.toolCalling] ?? p.toolCalling}</span>
              </div>
              <div className="provider-card-models">
                {p.models.length > 0 ? (
                  p.models.map((m, i) => (
                    <span key={`${m}-${i}`} className="provider-card-model-tag">{m}</span>
                  ))
                ) : (
                  <span className="provider-card-no-models">无模型</span>
                )}
              </div>
              <div className="provider-card-actions">
                <button className="provider-edit-btn" onClick={() => openEditDialog(p)}>编辑</button>
                <button className="provider-delete-btn" onClick={() => handleDelete(p.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}