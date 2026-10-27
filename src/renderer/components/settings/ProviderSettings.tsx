import React, { useState, useEffect, useRef } from 'react'
import { useProviderStore, type SafeProviderConfig } from '../../stores/providerStore'
import { useUiStore } from '../../stores/uiStore'
import { useDialogStack } from '../../hooks/useDialogStack'
import { Dropdown } from '../Dropdown'
import { Checkbox } from '../Checkbox'
import { SecretInput } from '../SecretInput'
import {
  INITIAL_EDITING_API_KEY,
  beginLoadingApiKey,
  finishLoadingApiKey,
  failLoadingApiKey,
  editApiKey,
  shouldCommitApiKey,
  type EditingApiKey,
} from '../../packages/secretInput'
import type {
  ImageGenerationParameterProfile,
  ImageGenerationParameterConfig,
  ImageGenerationProfilePresetId,
  ImageGenerationInputCardinality,
  ImageGenerationResponseFormatValueType,
  RequestParameterProfile,
  AnthropicMessagesConfig,
} from '../../../shared/types/provider'
import { normalizeImageGenerationProfile, openAIImageProfile, customMinimalProfile, customImageToImageProfile, validateImageGenerationPayloadPath } from '../../../shared/image-generation/parameterProfile'
import { validateRequestParameterProfile, computeReservedRequestPaths } from '../../../shared/request-parameters/requestParameters'
import { RequestParameterProfileEditor } from './RequestParameterProfileEditor'

const PROTOCOL_OPTIONS = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages API' },
  { value: 'image_generations', label: 'Image Generations' },
]

type ProviderProtocolValue = 'chat_completions' | 'responses' | 'anthropic_messages' | 'image_generations'

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

// ── Anthropic Messages API 高级设置 ──
// 协议特有参数全部收进「高级设置」折叠区，默认视图与其它服务商保持一致。
// 全部可选；未填写时使用安全默认值（x-api-key + 2023-06-01 + 自动 /v1/messages）。
// 注意：最大输出 Token 不再在服务商编辑窗口展示；未配置时请求仍按默认值 4096 发送，
// 已保存的自定义值在 pruneAnthropicConfig 中原样保留，不会因隐藏输入框而丢失。
const ANTHROPIC_KNOWN_VERSIONS = ['2023-06-01', '2026-10-21']

const ANTHROPIC_VERSION_OPTIONS = [
  { value: '2023-06-01', label: '2023-06-01（默认）' },
  { value: '2026-10-21', label: '2026-10-21' },
]

const ANTHROPIC_AUTH_OPTIONS = [
  { value: 'x-api-key', label: 'x-api-key（默认）' },
  { value: 'bearer', label: 'Bearer' },
]

const ANTHROPIC_THINKING_OPTIONS = [
  { value: 'off', label: '关闭（默认）' },
  { value: 'adaptive', label: '自适应' },
  { value: 'budget', label: '手动预算' },
]

// 清理空字段，避免把默认空壳写库；返回 undefined 表示全部使用默认值。
function pruneAnthropicConfig(config: AnthropicMessagesConfig): AnthropicMessagesConfig | undefined {
  const out: AnthropicMessagesConfig = {}
  if (config.apiVersion && config.apiVersion.trim()) out.apiVersion = config.apiVersion.trim()
  if (config.authMode) out.authMode = config.authMode
  if (config.endpoint && config.endpoint.trim()) out.endpoint = config.endpoint.trim()
  // 保留已有自定义 max_tokens（输入框已隐藏），不因 UI 简化而丢弃。
  if (typeof config.maxOutputTokens === 'number' && config.maxOutputTokens > 0) out.maxOutputTokens = config.maxOutputTokens
  if (config.thinking && config.thinking.mode !== 'off') out.thinking = config.thinking
  if (config.promptCaching) out.promptCaching = true
  return Object.keys(out).length > 0 ? out : undefined
}

// 版本下拉仅提供受支持的 2023-06-01 / 2026-10-21。
// 旧配置若保存了其它版本号，不静默覆盖：以一个禁用的 synthetic option 展示原值并提示，
// 用户明确选择受支持版本后才写回。
function AnthropicAdvancedEditor(props: {
  config: AnthropicMessagesConfig
  onChange: (next: AnthropicMessagesConfig) => void
  messagesPath: string
  onMessagesPathChange: (next: string) => void
}) {
  const { config, onChange, messagesPath, onMessagesPathChange } = props
  const rawVersion = config.apiVersion?.trim() ?? ''
  const isSupportedVersion = !rawVersion || ANTHROPIC_KNOWN_VERSIONS.includes(rawVersion)
  const version = isSupportedVersion ? (rawVersion || '2023-06-01') : rawVersion
  const authMode = config.authMode ?? 'x-api-key'
  const thinkingMode = config.thinking?.mode ?? 'off'

  const versionOptions = isSupportedVersion
    ? ANTHROPIC_VERSION_OPTIONS
    : [{ value: rawVersion, label: `${rawVersion}（不支持的版本，请选择）`, disabled: true, invalid: true }, ...ANTHROPIC_VERSION_OPTIONS]

  return (
    <div className="provider-anthropic-config">
      <div className="provider-form-field">
        <label className="provider-label">API 版本</label>
        <Dropdown
          className="provider-dropdown"
          value={version}
          options={versionOptions}
          onChange={(v) => onChange({ ...config, apiVersion: v })}
          ariaLabel="选择 Anthropic API 版本"
          matchTriggerWidth
        />
        <p className="provider-hint">
          {isSupportedVersion
            ? '默认 2023-06-01。选择 2026-10-21 时不发送 temperature / top_p / top_k。'
            : '当前保存的 API 版本不在受支持列表中，请选择一个受支持的版本。'}
        </p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">认证方式</label>
        <Dropdown
          className="provider-dropdown"
          value={authMode}
          options={ANTHROPIC_AUTH_OPTIONS}
          onChange={(v) => onChange({ ...config, authMode: v as 'x-api-key' | 'bearer' })}
          ariaLabel="选择认证方式"
          matchTriggerWidth
        />
        <p className="provider-hint">默认 x-api-key，兼容多数第三方中转；如服务商要求可切换为 Bearer。</p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">完整接口地址（可选）</label>
        <input
          className="provider-input"
          type="text"
          value={config.endpoint ?? ''}
          onChange={(e) => onChange({ ...config, endpoint: e.target.value.trim() || undefined })}
          placeholder="留空则按 Base URL 自动推导 /v1/messages"
        />
        <p className="provider-hint">填写后将原样使用该地址（不追加路径），适用于反向代理前缀。</p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">请求路径（可选）</label>
        <input
          className="provider-input"
          type="text"
          value={messagesPath}
          onChange={(e) => onMessagesPathChange(e.target.value)}
          placeholder="留空则自动推导 /v1/messages"
        />
        <p className="provider-hint">通常留空；仅当服务商的 Messages 接口路径与默认不同时填写。</p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">扩展思考</label>
        <Dropdown
          className="provider-dropdown"
          value={thinkingMode}
          options={ANTHROPIC_THINKING_OPTIONS}
          onChange={(v) =>
            onChange({
              ...config,
              thinking: v === 'off' ? { mode: 'off' } : { mode: v as 'adaptive' | 'budget', budgetTokens: config.thinking?.budgetTokens },
            })
          }
          ariaLabel="选择思考模式"
          matchTriggerWidth
        />
        {thinkingMode === 'budget' && (
          <input
            className="provider-input"
            type="number"
            min={1024}
            value={config.thinking?.budgetTokens ?? 4096}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              onChange({ ...config, thinking: { mode: 'budget', budgetTokens: Number.isFinite(n) ? n : undefined } })
            }}
            placeholder="思考预算（至少 1024）"
            style={{ marginTop: 6 }}
          />
        )}
        <p className="provider-hint">默认关闭。是否被模型接受取决于服务端能力；预算须小于最大输出 Token。</p>
      </div>

      <div className="provider-form-field">
        <label className="provider-label">Prompt Caching</label>
        <div className="provider-switch-row">
          <span>启用 ephemeral 缓存断点</span>
          <div
            className={`settings-switch ${config.promptCaching ? 'settings-switch-on' : ''}`}
            onClick={() => onChange({ ...config, promptCaching: !config.promptCaching })}
            role="switch"
            aria-checked={!!config.promptCaching}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onChange({ ...config, promptCaching: !config.promptCaching })
              }
            }}
          >
            <div className="settings-switch-thumb" />
          </div>
        </div>
        <p className="provider-hint">默认关闭。开启后在 system 与最后一条消息添加缓存断点（最多 2 个）。</p>
      </div>
    </div>
  )
}

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
            matchTriggerWidth
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
                matchTriggerWidth
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
  // 编辑既有 Provider 时该 Provider 是否已保存过 API Key（仅布尔元数据，绝不含明文）。
  // 用于区分「本来就没配 Key」与「读取真实 Key 失败」，避免对前者误报错误。
  initialHasApiKey: boolean
  initialModels: string[]
  initialToolCalling: 'auto' | 'enabled' | 'disabled'
  initialImageInput: boolean
  initialImageGenerationsPath: string
  initialImageGenerationProfile: ImageGenerationParameterProfile | null
  initialRequestParameterProfile: RequestParameterProfile | null
  initialAnthropic: AnthropicMessagesConfig | null
  initialAnthropicMessagesPath: string
  onSave: () => void
  onClose: () => void
}

function ProviderFormDialog(props: ProviderFormDialogProps) {
  const [name, setName] = useState(props.initialName)
  const [protocol, setProtocol] = useState<ProviderProtocolValue>(props.initialProtocol)
  const [baseUrl, setBaseUrl] = useState(props.initialBaseUrl)
  // API Key 的加载/编辑状态：value 始终是真实值，dirty 标记用户是否改动过。
  const [apiKeyState, setApiKeyState] = useState<EditingApiKey>(
    props.editId ? beginLoadingApiKey() : INITIAL_EDITING_API_KEY
  )
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
  // 通用请求参数 Profile（协议无关）：空 profile 归一化为 undefined，避免落库空壳。
  const [requestParameterProfile, setRequestParameterProfile] = useState<RequestParameterProfile | undefined>(
    props.initialRequestParameterProfile ?? undefined
  )
  // Anthropic Messages 协议配置（仅 protocol='anthropic_messages' 有意义）。
  const [anthropic, setAnthropic] = useState<AnthropicMessagesConfig>(props.initialAnthropic ?? {})
  const [anthropicMessagesPath, setAnthropicMessagesPath] = useState(props.initialAnthropicMessagesPath ?? '')
  // 「请求参数」默认折叠；仅高级用户需要。
  const [requestParamOpen, setRequestParamOpen] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState('')
  // 「高级协议兼容设置」默认折叠；普通用户无需理解协议细节。
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Anthropic 高级设置折叠状态（默认折叠，与普通服务商配置体验一致）。
  const [anthropicAdvancedOpen, setAnthropicAdvancedOpen] = useState(false)
  const [saveError, setSaveError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)
  const showToast = useUiStore((s) => s.showToast)

  const isImageProtocol = protocol === 'image_generations'
  const isAnthropicProtocol = protocol === 'anthropic_messages'
  const apiKey = apiKeyState.value

  useDialogStack(props.onClose)

  // 打开编辑弹窗时异步读取该 Provider 的真实 API Key（新建时为空）。
  // 读取期间禁用输入框，不预填任何假值；失败则保持空值且 dirty=false，避免误保存空值覆盖原 Key。
  useEffect(() => {
    if (!props.editId) {
      setApiKeyState(INITIAL_EDITING_API_KEY)
      return
    }
    // 该 Provider 本来就没配 Key：无需读取，直接置空且不报错。
    if (!props.initialHasApiKey) {
      setApiKeyState(INITIAL_EDITING_API_KEY)
      return
    }
    let cancelled = false
    setApiKeyState(beginLoadingApiKey())
    ;(async () => {
      try {
        const revealed = await window.openchat.providers.revealApiKey(props.editId as string)
        if (cancelled) return
        if (revealed) {
          setApiKeyState(finishLoadingApiKey(revealed))
        } else {
          setApiKeyState(failLoadingApiKey())
          showToast('无法读取 API Key')
        }
      } catch {
        // 错误对象可能携带凭证内容，不打印任何细节。
        if (cancelled) return
        setApiKeyState(failLoadingApiKey())
        showToast('无法读取 API Key')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.editId, props.initialHasApiKey])

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
        props.editId ?? undefined,
        isAnthropicProtocol
          ? { protocol: 'anthropic_messages', authMode: anthropic.authMode ?? 'x-api-key', apiVersion: anthropic.apiVersion }
          : undefined
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

    // 通用请求参数 Profile 保存前再校验一次（Renderer 侧即时反馈；Main 侧仍会权威校验）。
    // reservedPaths 与 Main 完全一致：核心字段 + 图片 requestMapping 位置（参考图 / response_format）。
    if (requestParameterProfile) {
      const reserved = computeReservedRequestPaths(protocol, isImageProtocol ? imageProfile : undefined)
      const rpError = validateRequestParameterProfile(requestParameterProfile, protocol, reserved)
      if (rpError) {
        setSaveError(`请求参数：${rpError}`)
        setRequestParamOpen(true)
        return
      }
    }

    if (props.editId) {
      const updates: Record<string, unknown> = {
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        models,
        toolCalling,
        imageInput,
        imageGenerationsPath: imageGenerationsPath.trim() || undefined,
        requestParameterProfile: requestParameterProfile ?? null,
      }
      // 仅图片协议保存 profile，避免污染 chat Provider 记录
      if (isImageProtocol) {
        updates.imageGenerationProfile = imageProfile
      }
      // Anthropic 配置仅在 Anthropic 协议下保存；切走时清空，避免残留污染。
      updates.anthropic = isAnthropicProtocol ? pruneAnthropicConfig(anthropic) : null
      updates.anthropicMessagesPath = isAnthropicProtocol ? (anthropicMessagesPath.trim() || undefined) : null
      // 只有用户真正改过 API Key 才写库；避免「打开 → 未修改 → 保存」重复写入，
      // 也避免把加载失败留下的空值覆盖掉原 Key。
      if (shouldCommitApiKey(apiKeyState)) {
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
        ...(requestParameterProfile ? { requestParameterProfile } : {}),
        ...(isAnthropicProtocol && pruneAnthropicConfig(anthropic) ? { anthropic: pruneAnthropicConfig(anthropic) } : {}),
        ...(isAnthropicProtocol && anthropicMessagesPath.trim() ? { anthropicMessagesPath: anthropicMessagesPath.trim() } : {}),
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
        <div className="provider-dialog-header">
          <h3>{props.editId ? '编辑模型服务' : '添加模型服务'}</h3>
        </div>

        <div className="provider-dialog-body">
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
            matchTriggerWidth
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
          <SecretInput
            value={apiKey}
            onChange={(next) => setApiKeyState(editApiKey(next))}
            placeholder="sk-..."
            disabled={apiKeyState.loading}
            aria-label="API Key"
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
                matchTriggerWidth
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
          </>
        )}

        {isAnthropicProtocol && (
          <div className="provider-form-field">
            <button
              type="button"
              className="provider-advanced-toggle"
              onClick={() => setAnthropicAdvancedOpen((v) => !v)}
              aria-expanded={anthropicAdvancedOpen}
            >
              <svg
                className={`provider-advanced-chevron${anthropicAdvancedOpen ? ' provider-advanced-chevron--open' : ''}`}
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
              <span>高级设置</span>
            </button>
            {anthropicAdvancedOpen && (
              <div className="provider-advanced-body">
                <AnthropicAdvancedEditor
                  config={anthropic}
                  onChange={setAnthropic}
                  messagesPath={anthropicMessagesPath}
                  onMessagesPathChange={setAnthropicMessagesPath}
                />
              </div>
            )}
          </div>
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
            {models.length > 0 && (
              <button
                className="provider-model-clear-btn"
                onClick={() => setModels([])}
              >
                清空全部
              </button>
            )}
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

        {/* 通用请求参数（协议无关）：声明该服务的模型支持哪些额外请求字段。
            默认折叠；不配置则请求体完全不变。 */}
        <div className="provider-form-field">
          <button
            type="button"
            className="provider-advanced-toggle"
            onClick={() => setRequestParamOpen((v) => !v)}
            aria-expanded={requestParamOpen}
          >
            <svg
              className={`provider-advanced-chevron${requestParamOpen ? ' provider-advanced-chevron--open' : ''}`}
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span>请求参数</span>
            {requestParameterProfile && (
              <span className="provider-advanced-count">
                {requestParameterProfile.providerParameters.length}
              </span>
            )}
          </button>
          {requestParamOpen && (
            <div className="provider-advanced-body">
              <p className="provider-hint">
                按该服务实际支持的请求字段声明参数（如 Steps、Seed、extra_body 内的字段）。
                未声明的参数不会出现在会话中，也不会随请求发送。
              </p>
              <RequestParameterProfileEditor
                profile={requestParameterProfile}
                protocol={protocol}
                models={models}
                onChange={setRequestParameterProfile}
              />
            </div>
          )}
        </div>

        {/* 保存错误（图片协议映射 / 通用请求参数校验失败）统一在底部提示 */}
        {saveError && <p className="provider-save-error">{saveError}</p>}

        </div>

        <div className="provider-dialog-footer">
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
    hasApiKey: false,
    models: [] as string[],
    toolCalling: 'auto' as 'auto' | 'enabled' | 'disabled',
    imageInput: false,
    imageGenerationsPath: '',
    imageGenerationProfile: null as ImageGenerationParameterProfile | null,
    requestParameterProfile: null as RequestParameterProfile | null,
    anthropic: null as AnthropicMessagesConfig | null,
    anthropicMessagesPath: '',
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
    setDialogInitial({ name: '', protocol: 'chat_completions', baseUrl: '', hasApiKey: false, models: [], toolCalling: 'auto', imageInput: false, imageGenerationsPath: '', imageGenerationProfile: null, requestParameterProfile: null, anthropic: null, anthropicMessagesPath: '' })
    setDialogOpen(true)
  }

  function openEditDialog(p: SafeProviderConfig) {
    setEditId(p.id)
    setDialogInitial({
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      // 明文不在此处传入：dialog 打开后自己通过 reveal IPC 按需读取（并标记 loading）。
      hasApiKey: p.hasApiKey,
      models: [...p.models],
      toolCalling: p.toolCalling,
      imageInput: p.imageInput ?? false,
      imageGenerationsPath: p.imageGenerationsPath ?? '',
      imageGenerationProfile: p.imageGenerationProfile ?? null,
      requestParameterProfile: p.requestParameterProfile ?? null,
      anthropic: p.anthropic ?? null,
      anthropicMessagesPath: p.anthropicMessagesPath ?? '',
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
          initialHasApiKey={dialogInitial.hasApiKey}
          initialModels={dialogInitial.models}
          initialToolCalling={dialogInitial.toolCalling}
          initialImageInput={dialogInitial.imageInput}
          initialImageGenerationsPath={dialogInitial.imageGenerationsPath}
          initialImageGenerationProfile={dialogInitial.imageGenerationProfile}
          initialRequestParameterProfile={dialogInitial.requestParameterProfile}
          initialAnthropic={dialogInitial.anthropic}
          initialAnthropicMessagesPath={dialogInitial.anthropicMessagesPath}
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