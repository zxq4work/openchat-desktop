import React, { useState, useEffect, useRef } from 'react'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'
import { useDialogStack } from '../../hooks/useDialogStack'
import { Dropdown } from '../Dropdown'
import { Checkbox } from '../Checkbox'
import type {
  ImageGenerationParameterProfile,
  ImageGenerationParameterConfig,
  ImageGenerationProfilePresetId,
  ImageGenerationInputCardinality,
  ImageGenerationResponseFormatValueType,
} from '../../../shared/types/provider'
import { normalizeImageGenerationProfile, openAIImageProfile, customMinimalProfile, customImageToImageProfile, validateImageGenerationPayloadPath } from '../../../shared/image-generation/parameterProfile'

const PROTOCOL_OPTIONS = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'image_generations', label: 'Image Generations' },
]

type ProviderProtocolValue = 'chat_completions' | 'responses' | 'image_generations'

// 图片 API 兼容预设：openai 官方兼容 / 自定义（含图生图扩展）/ 自定义最小集。
// 预设只是填写模板，保存后仍逐个字段存进 Profile；运行期能力一律以 Profile 为准，
// 绝不按供应商名称猜测。
const IMAGE_PROFILE_PRESET_OPTIONS = [
  { value: 'openai', label: 'OpenAI Images API' },
  { value: 'custom_image_to_image', label: '自定义（含图生图扩展）' },
  { value: 'custom', label: 'Custom' },
]

// 预设派生表。切换预设时重置整个 profile；用户可再在下方微调。
const IMAGE_PROFILE_PRESETS: Record<ImageGenerationProfilePresetId, () => ImageGenerationParameterProfile> = {
  openai: openAIImageProfile,
  custom_image_to_image: customImageToImageProfile,
  custom: customMinimalProfile,
}

// 判断已保存 profile 匹配哪个预设（仅用于下拉初始显示；不匹配时视为 custom）。
// 两侧都做 normalize，避免「缺省字段补齐」导致形式不同但语义相同的 profile 被判为 custom。
function inferProfilePreset(profile: ImageGenerationParameterProfile | null): ImageGenerationProfilePresetId {
  if (!profile) return 'custom'
  try {
    const serialized = JSON.stringify(normalizeImageGenerationProfile(profile))
    if (serialized === JSON.stringify(normalizeImageGenerationProfile(openAIImageProfile()))) return 'openai'
    if (serialized === JSON.stringify(normalizeImageGenerationProfile(customImageToImageProfile()))) return 'custom_image_to_image'
    return 'custom'
  } catch {
    return 'custom'
  }
}

// 保存前校验 Profile 的协议映射一致性：
// - 开启图生图 → 必须给出合法的参考图写入位置
// - response_format 启用 → 必须给出合法的字段位置
// 返回 null 表示可保存，否则返回面向用户的错误文案。
function validateImageProfileForSave(profile: ImageGenerationParameterProfile): string | null {
  const mapping = profile.requestMapping
  if (profile.operations?.imageToImage.enabled) {
    const path = mapping?.inputImages?.path?.trim()
    if (!path) return '已启用参考图生成，请配置参考图片请求字段。'
    const err = validateImageGenerationPayloadPath(path)
    if (err) return `参考图片请求字段无效：${err}`
  }
  const resp = mapping?.responseFormatParameter
  if (resp?.enabled) {
    const err = resp.path ? validateImageGenerationPayloadPath(resp.path) : '参数路径不能为空'
    if (err) return `响应控制参数路径无效：${err}`
  }
  return null
}

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

// ── Image Generation 参数 Profile 编辑器 ──
// 简化 UI：每个参数一行「支持」开关 + 允许值 chips（可增删）+ 「允许自定义值」开关。
// 目标不是 API IDE，只让用户声明该 Provider 真正支持哪些参数。

interface ParamEditorProps {
  label: string
  config: ImageGenerationParameterConfig
  onChange: (next: ImageGenerationParameterConfig) => void
  allowCustomToggle?: boolean
}

function ParamEditor({ label, config, onChange, allowCustomToggle }: ParamEditorProps) {
  const [newOption, setNewOption] = useState('')

  const addOption = () => {
    const value = newOption.trim()
    if (!value) return
    const options = [...(config.options ?? [])]
    if (options.some((o) => o.value === value)) return
    options.push({ label: value, value })
    onChange({ ...config, options })
    setNewOption('')
  }

  const removeOption = (value: string) => {
    const options = (config.options ?? []).filter((o) => o.value !== value)
    onChange({ ...config, options })
  }

  return (
    <div className="image-param-editor">
      <div className="image-param-head">
        <span className="image-param-label">{label}</span>
        <Checkbox
          checked={config.enabled}
          onChange={(checked) => onChange({ ...config, enabled: checked })}
          label="支持"
        />
      </div>
      {config.enabled && (
        <div className="image-param-body">
          <div className="image-param-options">
            {(config.options ?? []).map((o) => (
              <span key={o.value} className="image-param-chip">
                {o.value}
                <button
                  type="button"
                  className="image-param-chip-remove"
                  onClick={() => removeOption(o.value)}
                  aria-label={`移除 ${o.value}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="image-param-option-input"
              type="text"
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addOption()
                }
              }}
              placeholder="添加允许值后回车"
            />
            <button
              type="button"
              className="image-param-option-add"
              onClick={addOption}
              disabled={!newOption.trim()}
            >
              +
            </button>
          </div>
          {allowCustomToggle && (
            <Checkbox
              checked={config.allowCustom === true}
              onChange={(checked) => onChange({ ...config, allowCustom: checked })}
              label="允许自定义值"
            />
          )}
        </div>
      )}
    </div>
  )
}

interface ImageProfileEditorProps {
  profile: ImageGenerationParameterProfile
  onChange: (next: ImageGenerationParameterProfile) => void
}

function ImageProfileEditor({ profile, onChange }: ImageProfileEditorProps) {
  const update = (field: keyof ImageGenerationParameterProfile) => (next: ImageGenerationParameterConfig) => {
    onChange({ ...profile, [field]: next })
  }
  return (
    <div className="image-profile-editor">
      <ParamEditor label="尺寸" config={profile.size} onChange={update('size')} allowCustomToggle />
      <ParamEditor label="质量" config={profile.quality} onChange={update('quality')} />
      <ParamEditor label="背景" config={profile.background} onChange={update('background')} />
      <ParamEditor label="输出格式" config={profile.outputFormat} onChange={update('outputFormat')} />
    </div>
  )
}

const INPUT_CARDINALITY_OPTIONS = [
  { value: 'array', label: '数组（多张图片放在同一字段）' },
  { value: 'single', label: '单值（仅一张图片）' },
]

const RESPONSE_VALUE_TYPE_OPTIONS = [
  { value: 'string', label: '字符串（如 "b64_json"）' },
  { value: 'boolean', label: '布尔（true / false）' },
]

// ── 生成能力编辑器：文生图 / 参考图生成（图生图）──
// 是否支持图生图必须由这里显式声明，绝不由 Service / Adapter 按供应商名称猜测。
function OperationsEditor({ profile, onChange }: ImageProfileEditorProps) {
  const ops = profile.operations ?? { textToImage: true, imageToImage: { enabled: false, multiple: false } }
  const setOps = (next: typeof ops) => onChange({ ...profile, operations: next })
  const i2i = ops.imageToImage

  return (
    <div className="image-ops-editor">
      <Checkbox
        checked={ops.textToImage}
        onChange={(checked) => setOps({ ...ops, textToImage: checked })}
        label="文生图"
      />
      <Checkbox
        checked={i2i.enabled}
        onChange={(checked) => setOps({ ...ops, imageToImage: { ...i2i, enabled: checked } })}
        label="参考图生成（图生图）"
      />
      {i2i.enabled && (
        <div className="image-ops-nested">
          <Checkbox
            checked={i2i.multiple}
            onChange={(checked) => setOps({ ...ops, imageToImage: { ...i2i, multiple: checked, maxImages: checked ? (i2i.maxImages ?? 4) : 1 } })}
            label="支持多张参考图"
          />
          {i2i.multiple && (
            <label className="image-ops-number">
              <span>最大参考图数量</span>
              <input
                type="number"
                min={1}
                max={8}
                value={i2i.maxImages ?? 4}
                onChange={(e) => setOps({ ...ops, imageToImage: { ...i2i, maxImages: Number(e.target.value) } })}
              />
            </label>
          )}
        </div>
      )}
    </div>
  )
}

// ── 协议字段路径输入（带即时校验）──
// 只接受「顶层字段」或「extra_body.字段」；非法路径给出内联错误并阻止保存。
// 示例与提示由调用方提供，避免把某种字段名（如 response_format）当作通用约定。
function PathField({ label, value, placeholder, hint, onChange }: {
  label: string
  value: string
  placeholder: string
  hint: string
  onChange: (next: string) => void
}) {
  const error = value.trim() ? validateImageGenerationPayloadPath(value) : null
  return (
    <div className="provider-form-field">
      <label className="provider-label">{label}</label>
      <input
        className={`provider-input${error ? ' provider-input--error' : ''}`}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {error
        ? <p className="provider-hint provider-hint--error">{error}</p>
        : <p className="provider-hint">{hint}</p>}
    </div>
  )
}

// ── 高级协议兼容设置：参考图字段映射 + 响应控制参数 ──
// 这些是 Provider 协议细节，不是用户能力；普通用户无需修改，保持默认即可。
// 本地受管图片只能以 Data URI 发送（不存在「公网 URL」选项）。
// 不同 Provider 的响应控制字段名并不统一（response_format / extra_body.response_format /
// return_base64 …），故这里一律称「响应控制参数」，不假定字段名。
function RequestMappingEditor({ profile, onChange }: ImageProfileEditorProps) {
  const ops = profile.operations
  const i2iEnabled = ops?.imageToImage.enabled === true
  const mapping = profile.requestMapping ?? {}
  const input = mapping.inputImages
  const resp = mapping.responseFormatParameter

  const setInput = (next: typeof input) => onChange({ ...profile, requestMapping: { ...mapping, inputImages: next } })
  const setResp = (next: typeof resp) => onChange({ ...profile, requestMapping: { ...mapping, responseFormatParameter: next } })

  return (
    <div className="image-input-editor">
      {i2iEnabled && (
        <div className="provider-form-field">
          <label className="provider-label">参考图请求字段</label>
          <PathField
            label="参考图写入位置"
            value={input?.path ?? ''}
            placeholder="image 或 extra_body.image"
            hint="支持「顶层字段」或「extra_body.字段」，例如 image / input_image / reference_image / extra_body.image。"
            onChange={(path) => setInput({ path, cardinality: input?.cardinality ?? 'array', encoding: 'data_url' })}
          />
          <Dropdown
            className="provider-dropdown"
            value={input?.cardinality ?? 'array'}
            options={INPUT_CARDINALITY_OPTIONS}
            onChange={(v) => setInput({ path: input?.path ?? '', cardinality: v as ImageGenerationInputCardinality, encoding: 'data_url' })}
            ariaLabel="选择参考图写入形式"
          />
          <p className="provider-hint">本地参考图以 Data URI（Base64）写入该字段，绝不会上传到公网。</p>
        </div>
      )}

      <div className="provider-form-field">
        <label className="provider-label">响应传输控制</label>
        <Checkbox
          checked={resp?.enabled === true}
          onChange={(checked) => setResp({
            enabled: checked,
            path: resp?.path ?? '',
            valueType: resp?.valueType ?? 'string',
            value: resp?.value ?? 'b64_json',
          })}
          label="随请求发送响应控制参数"
        />
        {resp?.enabled && (
          <>
            <PathField
              label="参数路径"
              value={resp.path}
              placeholder="extra_body.response_format"
              hint="支持「顶层字段」或「extra_body.字段」。不同 Provider 字段名不同，例如 response_format / extra_body.response_format / return_base64。"
              onChange={(path) => setResp({ ...resp, path })}
            />
            <div className="provider-form-field">
              <label className="provider-label">值类型</label>
              <Dropdown
                className="provider-dropdown"
                value={resp.valueType}
                options={RESPONSE_VALUE_TYPE_OPTIONS}
                onChange={(v) => setResp({ ...resp, valueType: v as ImageGenerationResponseFormatValueType, value: v === 'boolean' ? true : 'b64_json' })}
                ariaLabel="选择参数值类型"
              />
            </div>
            <div className="provider-form-field">
              <label className="provider-label">参数值</label>
              {resp.valueType === 'boolean' ? (
                <Checkbox
                  checked={resp.value === true}
                  onChange={(checked) => setResp({ ...resp, value: checked })}
                  label={resp.value === true ? 'true' : 'false'}
                />
              ) : (
                <input
                  className="provider-input"
                  type="text"
                  value={String(resp.value ?? '')}
                  onChange={(e) => setResp({ ...resp, value: e.target.value })}
                  placeholder="b64_json"
                />
              )}
            </div>
            <p className="provider-hint">该参数仅影响请求；返回体是 Base64 还是 URL 由程序自动识别，不受此处设置限制。</p>
          </>
        )}
      </div>
    </div>
  )
}

interface ProviderFormDialogProps {
  editId: string | null
  initialName: string
  initialProtocol: ProviderProtocolValue
  initialBaseUrl: string
  initialApiKey: string
  initialModels: string[]
  initialToolCalling: 'auto' | 'enabled' | 'disabled'
  initialImageInput: boolean
  initialImageGenerationsPath: string
  initialImageGenerationProfile: ImageGenerationParameterProfile | null
  onSave: () => void
  onClose: () => void
}

function ProviderFormDialog(props: ProviderFormDialogProps) {
  const [name, setName] = useState(props.initialName)
  const [protocol, setProtocol] = useState<ProviderProtocolValue>(props.initialProtocol)
  const [baseUrl, setBaseUrl] = useState(props.initialBaseUrl)
  const [apiKey, setApiKey] = useState(props.initialApiKey)
  const [models, setModels] = useState<string[]>([...props.initialModels])
  const [newModelInput, setNewModelInput] = useState('')
  const [toolCalling, setToolCalling] = useState<'auto' | 'enabled' | 'disabled'>(props.initialToolCalling)
  const [imageInput, setImageInput] = useState(props.initialImageInput)
  const [imageGenerationsPath, setImageGenerationsPath] = useState(props.initialImageGenerationsPath)
  // 图片参数 Profile：派生预设只用于切换时重置；实际保存的是完整 profile 对象。
  const [imageProfile, setImageProfile] = useState<ImageGenerationParameterProfile>(
    normalizeImageGenerationProfile(props.initialImageGenerationProfile)
  )
  const [imagePreset, setImagePreset] = useState<ImageGenerationProfilePresetId>(
    inferProfilePreset(props.initialImageGenerationProfile)
  )
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState('')
  // 「高级协议兼容设置」默认折叠；普通用户无需理解协议细节。
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saveError, setSaveError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)

  const isImageProtocol = protocol === 'image_generations'

  useDialogStack(props.onClose)

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

    // 图片协议：先校验 Profile 的协议映射一致性，避免保存出「开启图生图但无位置」的畸形配置。
    if (isImageProtocol) {
      const profileError = validateImageProfileForSave(imageProfile)
      if (profileError) {
        setSaveError(profileError)
        setAdvancedOpen(true)
        return
      }
    }
    setSaveError('')

    if (props.editId) {
      const updates: Record<string, unknown> = {
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        models,
        toolCalling,
        imageInput,
        imageGenerationsPath: imageGenerationsPath.trim() || undefined,
      }
      // 仅图片协议保存 profile，避免污染 chat Provider 记录
      if (isImageProtocol) {
        updates.imageGenerationProfile = imageProfile
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
        imageInput,
        imageGenerationsPath: imageGenerationsPath.trim() || undefined,
        ...(isImageProtocol ? { imageGenerationProfile: imageProfile } : {}),
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
            onChange={(value) => setProtocol(value as ProviderProtocolValue)}
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

        {isImageProtocol && (
          <>
            <div className="provider-form-field">
              <label className="provider-label">图片生成路径</label>
              <input
                className="provider-input"
                type="text"
                value={imageGenerationsPath}
                onChange={(e) => setImageGenerationsPath(e.target.value)}
                placeholder="留空则默认 /images/generations（Base URL 含 /v1 时）"
              />
              <p className="provider-hint">图片生成请求相较 Base URL 的路径，通常无需修改。</p>
            </div>

            <div className="provider-form-field">
              <label className="provider-label">图片 API 兼容配置</label>
              <Dropdown
                className="provider-dropdown"
                value={imagePreset}
                options={IMAGE_PROFILE_PRESET_OPTIONS}
                onChange={(value) => {
                  const preset = value as ImageGenerationProfilePresetId
                  setImagePreset(preset)
                  // 切换预设重置整个 profile；用户可再在下方微调
                  setImageProfile(IMAGE_PROFILE_PRESETS[preset]())
                }}
                ariaLabel="选择图片 API 兼容配置"
              />
              <p className="provider-hint">
                不同图片服务的参数并不一致（部分不支持 output_format 或 size=auto）。请按实际支持的参数勾选；
                未勾选的参数不会出现在会话中，也不会随请求发送。
              </p>
            </div>

            {/* 图片能力：用户能理解的「这个服务能做什么」 */}
            <div className="provider-form-field">
              <label className="provider-label">图片能力</label>
              <OperationsEditor profile={imageProfile} onChange={setImageProfile} />
            </div>

            <div className="provider-form-field">
              <label className="provider-label">图片生成参数</label>
              <ImageProfileEditor profile={imageProfile} onChange={setImageProfile} />
            </div>

            {/* 高级协议兼容设置：协议字段映射（默认折叠，普通用户无需修改） */}
            <div className="provider-form-field">
              <button
                type="button"
                className="provider-advanced-toggle"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
              >
                <svg
                  className={`provider-advanced-chevron${advancedOpen ? ' provider-advanced-chevron--open' : ''}`}
                  width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span>高级协议兼容设置</span>
              </button>
              {advancedOpen && (
                <div className="provider-advanced-body">
                  <RequestMappingEditor profile={imageProfile} onChange={setImageProfile} />
                </div>
              )}
            </div>

            {saveError && <p className="provider-save-error">{saveError}</p>}
          </>
        )}

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

        {/* 暂时隐藏：capabilities.toolCalling 当前未在生成流程中被读取，tools 能力靠运行时检测 */}
        {/* <div className="provider-form-field">
          <label className="provider-label">Tools</label>
          <Dropdown
            className="provider-dropdown"
            value={toolCalling}
            options={TOOL_CALLING_OPTIONS}
            onChange={(value) => setToolCalling(value as 'auto' | 'enabled' | 'disabled')}
            ariaLabel="选择 Tools 模式"
          />
        </div> */}

        {!isImageProtocol && (
          <div className="provider-form-field">
            <label className="provider-label">图片输入</label>
            <div className="provider-switch-row">
              <span>该服务的模型支持图片输入</span>
              <div
                className={`settings-switch ${imageInput ? 'settings-switch-on' : ''}`}
                onClick={() => setImageInput(!imageInput)}
                role="switch"
                aria-checked={imageInput}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setImageInput(!imageInput)
                  }
                }}
              >
                <div className="settings-switch-thumb" />
              </div>
            </div>
            <p className="provider-hint">无法从模型名称自动推断，请按实际能力勾选；未勾选时按纯文本处理。</p>
          </div>
        )}

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
    protocol: 'chat_completions' as ProviderProtocolValue,
    baseUrl: '',
    apiKey: '',
    models: [] as string[],
    toolCalling: 'auto' as 'auto' | 'enabled' | 'disabled',
    imageInput: false,
    imageGenerationsPath: '',
    imageGenerationProfile: null as ImageGenerationParameterProfile | null,
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
    setDialogInitial({ name: '', protocol: 'chat_completions', baseUrl: '', apiKey: '', models: [], toolCalling: 'auto', imageInput: false, imageGenerationsPath: '', imageGenerationProfile: null })
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
      imageInput: p.imageInput ?? false,
      imageGenerationsPath: p.imageGenerationsPath ?? '',
      imageGenerationProfile: p.imageGenerationProfile ?? null,
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
          initialImageInput={dialogInitial.imageInput}
          initialImageGenerationsPath={dialogInitial.imageGenerationsPath}
          initialImageGenerationProfile={dialogInitial.imageGenerationProfile}
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
                {/* <span className="provider-card-tool-mode">Tools: {TOOL_CALLING_LABELS[p.toolCalling] ?? p.toolCalling}</span> */}
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