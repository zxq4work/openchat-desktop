import React, { useState, useEffect } from 'react'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'

const PROTOCOL_LABELS: Record<string, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
}

const TOOL_CALLING_LABELS: Record<string, string> = {
  auto: '自动',
  enabled: '开启',
  disabled: '关闭',
}

export function ProviderSettings() {
  const providers = useProviderStore((s) => s.providers)
  const setProviders = useProviderStore((s) => s.setProviders)
  const [editId, setEditId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  // 表单状态
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<'chat_completions' | 'responses'>('chat_completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [newModelInput, setNewModelInput] = useState('')
  const [toolCalling, setToolCalling] = useState<'auto' | 'enabled' | 'disabled'>('auto')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState('')

  useEffect(() => {
    loadProviders()
  }, [])

  async function loadProviders() {
    const list = await window.openchat.providers.list()
    setProviders(list as SafeProviderConfig[])
  }

  function resetForm() {
    setName('')
    setProtocol('chat_completions')
    setBaseUrl('')
    setApiKey('')
    setModels([])
    setNewModelInput('')
    setToolCalling('auto')
    setEditId(null)
    setShowForm(false)
    setFetchingModels(false)
    setFetchError('')
  }

  function editProvider(p: SafeProviderConfig) {
    setName(p.name)
    setProtocol(p.protocol)
    setBaseUrl(p.baseUrl)
    setApiKey('')
    setModels([...p.models])
    setNewModelInput('')
    setToolCalling(p.toolCalling)
    setEditId(p.id)
    setShowForm(true)
    setFetchError('')
  }

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
        editId ?? undefined
      )
      if (fetchedModels.length === 0) {
        setFetchError('未获取到模型，请检查 API 地址和 Key')
      } else {
        // 合并而非覆盖：保留手动添加的模型，追加新获取的模型
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

    if (editId) {
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
      await window.openchat.providers.update(editId, updates)
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

    resetForm()
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
        {!showForm && (
          <button className="provider-add-btn" onClick={() => setShowForm(true)}>
            + 添加
          </button>
        )}
      </div>

      {showForm && (
        <div className="provider-form">
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
            <select
              className="provider-input"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as 'chat_completions' | 'responses')}
            >
              {Object.entries(PROTOCOL_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
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
              placeholder={editId ? '留空则不修改' : 'sk-...'}
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
                disabled={fetchingModels || !baseUrl.trim() || (!apiKey.trim() && !editId)}
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
            <select
              className="provider-input"
              value={toolCalling}
              onChange={(e) => setToolCalling(e.target.value as 'auto' | 'enabled' | 'disabled')}
            >
              {Object.entries(TOOL_CALLING_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          <div className="provider-form-actions">
            <button
              className="provider-save-btn"
              onClick={handleSave}
              disabled={!name.trim() || !baseUrl.trim()}
            >
              {editId ? '保存' : '添加'}
            </button>
            <button className="provider-cancel-btn" onClick={resetForm}>取消</button>
          </div>
        </div>
      )}

      {providers.length > 0 && (
        <div className="provider-list">
          {providers.map((p) => (
            <div key={p.id} className="provider-card">
              <div className="provider-card-header">
                <span className="provider-card-name">{p.name}</span>
                <span className="provider-card-badge">{PROTOCOL_LABELS[p.protocol] ?? p.protocol}</span>
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
                <button className="provider-edit-btn" onClick={() => editProvider(p)}>编辑</button>
                <button className="provider-delete-btn" onClick={() => handleDelete(p.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}