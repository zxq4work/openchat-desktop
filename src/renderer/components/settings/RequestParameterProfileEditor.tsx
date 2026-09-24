import React, { useState } from 'react'
import { Dropdown } from '../Dropdown'
import { Checkbox } from '../Checkbox'
import {
  validateDefinition,
  validateRequestPath,
  isProtectedRequestPath,
  MAX_REQUEST_PARAMETERS,
} from '../../../shared/request-parameters/requestParameters'
import type {
  DynamicRequestParameterDefinition,
  RequestParameterModelOverride,
  RequestParameterPlacement,
  RequestParameterProfile,
  RequestParameterType,
  ProviderProtocol,
} from '../../../shared/types/provider'

// ── Provider Settings：通用「请求参数」编辑器 ──
// 目标：让配置者在 Provider Settings 里声明任意 Provider / Model 的额外 request body 字段，
// 而无需修改任何 Adapter / Composer / DB schema 代码。
// 主界面只显示简洁列表（名称 / 路径 / 类型 / 位置），点击条目展开编辑，避免把整表单铺开。

const TYPE_OPTIONS = [
  { value: 'number', label: '数字' },
  { value: 'string', label: '文本' },
  { value: 'boolean', label: '布尔' },
  { value: 'select', label: '下拉选择' },
]

const PLACEMENT_OPTIONS = [
  { value: 'primary', label: '常用' },
  { value: 'advanced', label: '高级' },
  { value: 'hidden', label: '隐藏（固定值）' },
]

const TYPE_LABELS: Record<RequestParameterType, string> = {
  number: '数字',
  string: '文本',
  boolean: '布尔',
  select: '下拉',
}
const PLACEMENT_LABELS: Record<RequestParameterPlacement, string> = {
  primary: '常用',
  advanced: '高级',
  hidden: '隐藏',
}

// 参数 ID 允许字符集（与 shared validator 一致）。
const ID_PATTERN = /^[a-zA-Z0-9._-]+$/

function emptyDefinition(): DynamicRequestParameterDefinition {
  return {
    id: '',
    label: '',
    path: '',
    type: 'number',
    placement: 'advanced',
  }
}

// 切换类型时清掉不兼容字段（min/max/step/options/fixedValue 类型不符），避免脏 schema。
function retypeDefinition(def: DynamicRequestParameterDefinition, type: RequestParameterType): DynamicRequestParameterDefinition {
  const next: DynamicRequestParameterDefinition = {
    id: def.id,
    label: def.label,
    path: def.path,
    type,
    placement: def.placement,
  }
  if (def.description) next.description = def.description
  if (def.semantic) next.semantic = def.semantic
  if (def.required) next.required = true
  // fixedValue 仅在类型兼容时保留。
  if (def.fixedValue !== undefined && isValueOfType(def.fixedValue, type)) next.fixedValue = def.fixedValue
  if (type === 'number') {
    if (def.min !== undefined) next.min = def.min
    if (def.max !== undefined) next.max = def.max
    if (def.step !== undefined) next.step = def.step
  }
  if (type === 'select') {
    next.options = def.options && def.options.length > 0 ? def.options : [{ label: '', value: '' }]
  }
  return next
}

function isValueOfType(value: string | number | boolean, type: RequestParameterType): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'select') return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  return typeof value === 'string'
}

interface DefinitionEditorProps {
  def: DynamicRequestParameterDefinition
  protocol: ProviderProtocol
  isNew: boolean
  existingIds: string[]
  onChange: (next: DynamicRequestParameterDefinition) => void
  // onDone 回传归一化后的定义，避免父组件读到尚未同步的本地 draft（React 状态更新是异步的）。
  onDone: (next: DynamicRequestParameterDefinition) => void
  onCancel: () => void
}

function DefinitionEditor({ def, protocol, isNew, existingIds, onChange, onDone, onCancel }: DefinitionEditorProps) {
  const [newOptionLabel, setNewOptionLabel] = useState('')
  const [newOptionValue, setNewOptionValue] = useState('')

  const idError = def.id
    ? (!ID_PATTERN.test(def.id) ? '只能包含字母、数字、点、下划线、短横线' : (isNew && existingIds.includes(def.id) ? '参数 ID 已存在' : null))
    : '参数 ID 不能为空'
  const pathError = def.path
    ? (validateRequestPath(def.path) ?? (isProtectedRequestPath(protocol, def.path) ? '该字段由 OpenChat 协议核心参数管理，不能重复配置' : null))
    : '字段路径不能为空'
  const labelError = def.label.trim() ? null : '显示名称不能为空'
  const definitionError = validateDefinition({ ...def, path: def.path || '__', label: def.label || '__' })

  const set = (patch: Partial<DynamicRequestParameterDefinition>) => onChange({ ...def, ...patch })

  const addOption = () => {
    const label = newOptionLabel.trim()
    const rawValue = newOptionValue.trim()
    if (!label && !rawValue) return
    const options = [...(def.options ?? [])]
    // option value 依类型解析；第一版只支持 scalar。
    const value = parseOptionValue(rawValue || label, def.type)
    if (value === undefined) return
    options.push({ label: label || String(value), value })
    set({ options })
    setNewOptionLabel('')
    setNewOptionValue('')
  }

  const removeOption = (index: number) => {
    set({ options: (def.options ?? []).filter((_, i) => i !== index) })
  }

  const blockSave = !!idError || !!pathError || !!labelError || !!definitionError

  return (
    <div className="reqparam-editor">
      <div className="provider-form-field">
        <label className="provider-label">参数 ID</label>
        <input
          className={`provider-input${idError ? ' provider-input--error' : ''}`}
          type="text"
          value={def.id}
          readOnly={!isNew}
          onChange={(e) => set({ id: e.target.value })}
          placeholder="如 max-output"
        />
        <p className={`provider-hint${idError ? ' provider-hint--error' : ''}`}>
          {isNew ? '创建后不可修改（OpenChat 内部标识，与请求字段路径无关）。' : '参数 ID 创建后不可修改。'}
          {idError ? ` ${idError}` : ''}
        </p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">显示名称</label>
        <input
          className={`provider-input${labelError ? ' provider-input--error' : ''}`}
          type="text"
          value={def.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder="如 Steps / 最大输出 Token"
        />
      </div>

      <div className="provider-form-field">
        <label className="provider-label">说明（可选）</label>
        <input
          className="provider-input"
          type="text"
          value={def.description ?? ''}
          onChange={(e) => set({ description: e.target.value || undefined })}
          placeholder="鼠标悬停提示"
        />
      </div>

      <div className="provider-form-field">
        <label className="provider-label">字段路径</label>
        <input
          className={`provider-input${pathError ? ' provider-input--error' : ''}`}
          type="text"
          value={def.path}
          onChange={(e) => set({ path: e.target.value })}
          placeholder="如 steps 或 extra_body.num_inference_steps"
        />
        <p className={`provider-hint${pathError ? ' provider-hint--error' : ''}`}>
          {pathError ?? '支持「顶层字段」或「extra_body.字段」。用户看不到此路径，只看到显示名称。'}
        </p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">类型</label>
        <Dropdown
          className="provider-dropdown"
          value={def.type}
          options={TYPE_OPTIONS}
          onChange={(v) => onChange(retypeDefinition(def, v as RequestParameterType))}
          ariaLabel="选择参数类型"
        />
      </div>

      <div className="provider-form-field">
        <label className="provider-label">显示位置</label>
        <Dropdown
          className="provider-dropdown"
          value={def.placement}
          options={PLACEMENT_OPTIONS}
          onChange={(v) => set({ placement: v as RequestParameterPlacement })}
          ariaLabel="选择显示位置"
        />
      </div>

      {def.type === 'number' && (
        <div className="reqparam-number-grid">
          <label className="reqparam-number-field">
            <span>最小值</span>
            <input
              type="number"
              className="provider-input"
              value={def.min ?? ''}
              onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>
          <label className="reqparam-number-field">
            <span>最大值</span>
            <input
              type="number"
              className="provider-input"
              value={def.max ?? ''}
              onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>
          <label className="reqparam-number-field">
            <span>步长</span>
            <input
              type="number"
              className="provider-input"
              value={def.step ?? ''}
              onChange={(e) => set({ step: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      {def.type === 'select' && (
        <div className="provider-form-field">
          <label className="provider-label">候选项</label>
          <div className="reqparam-options">
            {(def.options ?? []).map((o, i) => (
              <div key={i} className="reqparam-option-row">
                <span className="reqparam-option-label">{o.label}</span>
                <span className="reqparam-option-value">{String(o.value)}</span>
                <button type="button" className="reqparam-option-remove" onClick={() => removeOption(i)} aria-label="移除候选项">×</button>
              </div>
            ))}
            <div className="reqparam-option-add">
              <input
                className="provider-input"
                type="text"
                value={newOptionLabel}
                onChange={(e) => setNewOptionLabel(e.target.value)}
                placeholder="显示名"
              />
              <input
                className="provider-input"
                type="text"
                value={newOptionValue}
                onChange={(e) => setNewOptionValue(e.target.value)}
                placeholder="值"
              />
              <button
                type="button"
                className="provider-model-add-btn"
                onClick={addOption}
                disabled={!newOptionLabel.trim() && !newOptionValue.trim()}
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {def.placement === 'hidden' && (
        <div className="provider-form-field">
          <label className="provider-label">固定值</label>
          <FixedValueInput def={def} onChange={(v) => set({ fixedValue: v })} />
          <p className="provider-hint">隐藏参数不显示给用户，但会在每次请求中固定发送该值。</p>
        </div>
      )}

      <div className="reqparam-editor-footer">
        <button className="btn-cancel" type="button" onClick={onCancel}>取消</button>
        <button
          className="btn-save"
          type="button"
          disabled={blockSave}
          onClick={() => {
            // 提交前归一化：清掉与类型无关的残留字段（step 等）。
            const normalized = normalizeForSave(def)
            onChange(normalized)
            onDone(normalized)
          }}
        >
          确定
        </button>
      </div>
    </div>
  )
}

// 保存前清理：按类型去除不相关字段，避免脏 schema 落库。
function normalizeForSave(def: DynamicRequestParameterDefinition): DynamicRequestParameterDefinition {
  const out: DynamicRequestParameterDefinition = {
    id: def.id.trim(),
    label: def.label.trim(),
    path: def.path.trim(),
    type: def.type,
    placement: def.placement,
  }
  if (def.description?.trim()) out.description = def.description.trim()
  if (def.required) out.required = true
  if (def.fixedValue !== undefined && def.placement === 'hidden') out.fixedValue = def.fixedValue
  if (def.type === 'number') {
    if (def.min !== undefined) out.min = def.min
    if (def.max !== undefined) out.max = def.max
    if (def.step !== undefined) out.step = def.step
  }
  if (def.type === 'select') {
    out.options = (def.options ?? []).filter((o) => o.label.trim() || String(o.value).trim())
  }
  return out
}

function parseOptionValue(raw: string, type: RequestParameterType): string | number | boolean | undefined {
  if (type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  return raw
}

// 固定值输入：按类型渲染（数字 / 布尔 / 文本）。
function FixedValueInput({ def, onChange }: { def: DynamicRequestParameterDefinition; onChange: (v: string | number | boolean | undefined) => void }) {
  if (def.type === 'boolean') {
    return (
      <Checkbox
        checked={def.fixedValue === true}
        onChange={(checked) => onChange(checked)}
        label={def.fixedValue === true ? 'true' : 'false'}
      />
    )
  }
  if (def.type === 'number') {
    return (
      <input
        className="provider-input"
        type="number"
        value={typeof def.fixedValue === 'number' ? def.fixedValue : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    )
  }
  return (
    <input
      className="provider-input"
      type="text"
      value={typeof def.fixedValue === 'string' ? def.fixedValue : ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    />
  )
}

// ── 最外层：Provider 参数列表 + 模型覆盖 ──
interface RequestParameterProfileEditorProps {
  profile: RequestParameterProfile | undefined
  protocol: ProviderProtocol
  models: string[]
  onChange: (next: RequestParameterProfile | undefined) => void
}

export function RequestParameterProfileEditor({ profile, protocol, models, onChange }: RequestParameterProfileEditorProps) {
  const [scope, setScope] = useState<'provider' | 'model'>('provider')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(models[0] ?? '')
  const [manualModel, setManualModel] = useState('')

  const providerParameters = profile?.providerParameters ?? []
  const modelOverrides = profile?.modelOverrides ?? {}
  const modelKey = models.includes(selectedModel) ? selectedModel : manualModel.trim()
  const activeModelOverride: RequestParameterModelOverride = modelOverrides[modelKey] ?? {}

  const setProviderParameters = (list: DynamicRequestParameterDefinition[]) => {
    const next: RequestParameterProfile = {
      version: profile?.version ?? 1,
      providerParameters: list,
      ...(profile?.modelOverrides ? { modelOverrides: profile.modelOverrides } : {}),
    }
    onChange(isEmptyProfile(next) ? undefined : next)
  }

  const setModelOverride = (list: DynamicRequestParameterDefinition[], disabledIds?: string[]) => {
    if (!modelKey) return
    const overrides = { ...modelOverrides }
    const override: RequestParameterModelOverride = {}
    if (list.length > 0) override.parameters = list
    const disabled = disabledIds ?? overrides[modelKey]?.disabledParameterIds
    if (disabled && disabled.length > 0) override.disabledParameterIds = disabled
    if (!override.parameters && !override.disabledParameterIds) {
      delete overrides[modelKey]
    } else {
      overrides[modelKey] = override
    }
    const next: RequestParameterProfile = {
      version: profile?.version ?? 1,
      providerParameters,
      ...(Object.keys(overrides).length > 0 ? { modelOverrides: overrides } : {}),
    }
    onChange(isEmptyProfile(next) ? undefined : next)
  }

  // 当前编辑作用域下的列表。
  const currentList = scope === 'provider' ? providerParameters : (activeModelOverride.parameters ?? [])
  const applyList = (list: DynamicRequestParameterDefinition[]) => {
    if (scope === 'provider') setProviderParameters(list)
    else setModelOverride(list)
  }

  const disabledIds = activeModelOverride.disabledParameterIds ?? []
  const existingIds = currentList.filter((d) => d.id !== editingId).map((d) => d.id)

  // 编辑 / 新建共用一个本地草稿：未点「确定」前绝不写入 profile。
  const [draft, setDraft] = useState<DynamicRequestParameterDefinition>(emptyDefinition())
  const editorDef = editingId ? draft : undefined

  const startAdd = () => {
    setDraft(emptyDefinition())
    setIsNew(true)
    setEditingId('__new__')
  }
  const startEdit = (id: string) => {
    const existing = currentList.find((d) => d.id === id)
    if (!existing) return
    setDraft({ ...existing })
    setIsNew(false)
    setEditingId(id)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setIsNew(false)
  }
  const commit = (next: DynamicRequestParameterDefinition) => {
    if (isNew) {
      applyList([...currentList, next])
    } else {
      applyList(currentList.map((d) => (d.id === next.id ? next : d)))
    }
  }
  const removeDef = (id: string) => {
    applyList(currentList.filter((d) => d.id !== id))
  }
  const toggleDisable = (id: string, disabled: boolean) => {
    const next = disabled ? [...disabledIds, id] : disabledIds.filter((x) => x !== id)
    setModelOverride(activeModelOverride.parameters ?? [], next)
  }

  const atLimit = currentList.length >= MAX_REQUEST_PARAMETERS

  return (
    <div className="reqparam-profile">
      <div className="reqparam-scope-tabs">
        <button
          type="button"
          className={`reqparam-scope-tab${scope === 'provider' ? ' active' : ''}`}
          onClick={() => { setScope('provider'); cancelEdit() }}
        >
          Provider 参数
        </button>
        <button
          type="button"
          className={`reqparam-scope-tab${scope === 'model' ? ' active' : ''}`}
          onClick={() => { setScope('model'); cancelEdit() }}
        >
          模型覆盖
        </button>
      </div>

      {scope === 'model' && (
        <div className="provider-form-field">
          <label className="provider-label">目标模型</label>
          {models.length > 0 ? (
            <Dropdown
              className="provider-dropdown"
              value={selectedModel}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={(v) => { setSelectedModel(v); setManualModel(''); cancelEdit() }}
              ariaLabel="选择要覆盖的模型"
            />
          ) : (
            <input
              className="provider-input"
              type="text"
              value={manualModel}
              onChange={(e) => { setManualModel(e.target.value); cancelEdit() }}
              placeholder="输入模型 ID（本地模型请输入完整 ID）"
            />
          )}
          <p className="provider-hint">
            未配置覆盖的模型直接继承「Provider 参数」。切换模型时旧参数值会保留，但请求只发送当前模型支持的参数。
          </p>
        </div>
      )}

      {scope === 'provider' ? (
        <ProviderParamList
          list={providerParameters}
          editorDef={editorDef}
          editingId={editingId}
          isNew={isNew}
          protocol={protocol}
          existingIds={existingIds}
          onChangeDraft={setDraft}
          onEdit={startEdit}
          onRemove={removeDef}
          onAdd={startAdd}
          onCancel={cancelEdit}
          onCommit={commit}
          atLimit={atLimit}
        />
      ) : (
        <>
          {providerParameters.length > 0 && (
            <div className="reqparam-disabled-block">
              <label className="provider-label">继承的 Provider 参数</label>
              {providerParameters.map((d) => (
                <div key={d.id} className="reqparam-disabled-row">
                  <Checkbox
                    checked={!disabledIds.includes(d.id)}
                    onChange={(checked) => toggleDisable(d.id, !checked)}
                    label={`${d.label}（${d.path}）`}
                  />
                </div>
              ))}
              <p className="provider-hint">取消勾选即在该模型上禁用此参数（UI 不显示、请求不发送）。</p>
            </div>
          )}
          <ProviderParamList
            list={activeModelOverride.parameters ?? []}
            editorDef={editorDef}
            editingId={editingId}
            isNew={isNew}
            protocol={protocol}
            existingIds={existingIds}
            onChangeDraft={setDraft}
            onEdit={startEdit}
            onRemove={removeDef}
            onAdd={startAdd}
            onCancel={cancelEdit}
            onCommit={commit}
            atLimit={atLimit}
            emptyHint="该模型暂无专属参数。可添加，或在上方禁用继承的 Provider 参数。"
          />
        </>
      )}
    </div>
  )
}

interface ProviderParamListProps {
  list: DynamicRequestParameterDefinition[]
  editorDef: DynamicRequestParameterDefinition | undefined
  editingId: string | null
  isNew: boolean
  protocol: ProviderProtocol
  existingIds: string[]
  onChangeDraft: (def: DynamicRequestParameterDefinition) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onCancel: () => void
  onCommit: (def: DynamicRequestParameterDefinition) => void
  atLimit: boolean
  emptyHint?: string
}

function ProviderParamList(props: ProviderParamListProps) {
  const { list, editingId, isNew, editorDef } = props

  return (
    <div className="reqparam-list">
      {list.length === 0 && !isNew && (
        <p className="provider-hint">{props.emptyHint ?? '尚未配置任何请求参数。'}</p>
      )}
      {list.map((def) => (
        <React.Fragment key={def.id}>
          <div className="reqparam-item">
            <div className="reqparam-item-main">
              <span className="reqparam-item-label">{def.label}</span>
              <span className="reqparam-item-path">{def.path}</span>
            </div>
            <div className="reqparam-item-meta">
              <span>{TYPE_LABELS[def.type]}</span>
              <span>{PLACEMENT_LABELS[def.placement]}</span>
            </div>
            <div className="reqparam-item-actions">
              <button type="button" className="provider-edit-btn" onClick={() => props.onEdit(def.id)}>编辑</button>
              <button type="button" className="provider-delete-btn" onClick={() => props.onRemove(def.id)}>删除</button>
            </div>
          </div>
          {editingId === def.id && !isNew && editorDef && (
            <DefinitionEditor
              def={editorDef}
              protocol={props.protocol}
              isNew={false}
              existingIds={props.existingIds}
              onChange={props.onChangeDraft}
              onDone={(next) => { props.onCommit(next); props.onCancel() }}
              onCancel={props.onCancel}
            />
          )}
        </React.Fragment>
      ))}

      {isNew && editorDef && (
        <DefinitionEditor
          def={editorDef}
          protocol={props.protocol}
          isNew
          existingIds={props.existingIds}
          onChange={props.onChangeDraft}
          onDone={(next) => { props.onCommit(next); props.onCancel() }}
          onCancel={props.onCancel}
        />
      )}

      {!editingId && (
        <button
          type="button"
          className="reqparam-add-btn"
          onClick={props.onAdd}
          disabled={props.atLimit}
        >
          + 添加参数
        </button>
      )}
    </div>
  )
}

function isEmptyProfile(profile: RequestParameterProfile): boolean {
  return profile.providerParameters.length === 0 && (!profile.modelOverrides || Object.keys(profile.modelOverrides).length === 0)
}
