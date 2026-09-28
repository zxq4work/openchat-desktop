import type {
  DynamicRequestParameterDefinition,
  ImageGenerationParameterProfile,
  RequestParameterModelOverride,
  RequestParameterOption,
  RequestParameterPlacement,
  RequestParameterProfile,
  RequestParameterType,
  RequestParameterValues,
  ResolvedRequestParameter,
  ProviderProtocol,
} from '../types/provider'

// 通用「动态请求参数」的纯逻辑：路径安全、定义校验、resolve、值校验、注入 body。
// 不依赖 Node / Electron，供 Main（权威层）与 Renderer（UI）共用，便于单测。
//
// 设计约束：
// - Core 不认识具体参数名（steps / max_tokens / … 一律只是配置数据）；
// - path 只允许「顶层字段」或「extra_body.字段」，明确拒绝原型污染字段；
// - unset（值不存在）→ 不发送字段；绝不发送 "default" / 0 / Provider 猜测值。

export const REQUEST_PARAMETER_PROFILE_VERSION = 1

// Provider scope 内参数数量上限，防止配置滥用导致 UI / JSON 膨胀。
export const MAX_REQUEST_PARAMETERS = 32

// 参数 id 允许的字符集（不用作 path，仅 identity）。
const PARAMETER_ID_PATTERN = /^[a-zA-Z0-9._-]+$/

// ── 路径安全（与 Image Generation requestMapping 共用同一套规则）──
// 只允许 '<顶层字段>' 或 'extra_body.<字段>'。
// 明确拒绝任意嵌套（a.b.c）与原型污染字段。
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  // 允许普通 object prototype 场景下的危险方法名，避免意外触发。
  'toString',
  'valueOf',
  'hasOwnProperty',
])
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// 校验请求体字段路径。返回 null 表示合法，否则返回面向用户的错误文案。
export function validateRequestPath(path: string): string | null {
  const trimmed = (path ?? '').trim()
  if (!trimmed) return '字段路径不能为空'
  const segments = trimmed.split('.')
  if (segments.length > 2) return '字段路径仅支持「顶层字段」或「extra_body.字段」'
  if (segments.some((s) => !SAFE_PATH_SEGMENT_PATTERN.test(s))) return '字段路径含非法字符'
  if (segments.some((s) => FORBIDDEN_PATH_SEGMENTS.has(s))) return '字段路径含保留字段'
  if (segments.length === 2 && segments[0] !== 'extra_body') return '二级路径必须以 extra_body 开头'
  // 顶层单独一个 extra_body 会整体覆盖容器（丢失映射写入的其它字段），明确禁止。
  if (segments.length === 1 && segments[0] === 'extra_body') return '字段路径不能直接指向 extra_body'
  return null
}

// 把值写入 body 的指定路径。
// - 顶层：body[field] = value
// - extra_body.<field>：与已有 extra_body 合并（绝不覆盖整个 extra_body）
// 迁移自 Image Generation 的 writeProviderPayloadField，作为统一 helper 复用。
//
// 冲突策略：目标字段若已存在（核心字段 / requestMapping 写入 / 另一动态参数重复写入）→ 抛错，
// 绝不 last-write-wins（静默覆盖会让用户以为参数生效，实际被核心值覆盖或反过来）。
export class RequestFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestFieldError'
  }
}

export function applyRequestField(
  body: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const err = validateRequestPath(path)
  if (err) throw new RequestFieldError(`字段路径无效：${err}`)
  const segments = path.trim().split('.')
  if (segments.length === 2) {
    const container = segments[0]
    const existing = body[container]
    if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
      // 不覆盖已有非 object 的 extra_body，避免静默丢失已有字段。
      throw new RequestFieldError(`字段 ${container} 已存在且不是对象，无法写入 ${path}`)
    }
    const base = Object.prototype.hasOwnProperty.call(body, container)
      ? (existing as Record<string, unknown>)
      : {}
    if (Object.prototype.hasOwnProperty.call(base, segments[1])) {
      throw new RequestFieldError(`请求字段「${path}」已被占用，不能重复写入`)
    }
    body[container] = { ...base, [segments[1]]: value }
    return
  }
  const field = segments[0]
  if (Object.prototype.hasOwnProperty.call(body, field)) {
    throw new RequestFieldError(`请求字段「${path}」已被占用，不能重复写入`)
  }
  body[field] = value
}

// ── 协议核心字段保护 ──
// 动态参数绝不能覆盖适配器必须控制的协议字段（model / messages / input / stream / tools / prompt …）。
// 由 protocol 决定保护集合，UI 与 Main 共享同一份，避免多处重复列表。
// 仅保护「适配器真实会写入、且以业务逻辑决定值」的字段；
// 适配器从不写入的字段（如 max_tokens / max_output_tokens / temperature —— 无任何调用方设置）
// 不在此列，允许作为动态参数自由配置。
export function getProtectedRequestPaths(protocol: ProviderProtocol): Set<string> {
  const set = new Set<string>([
    // 所有协议通用：模型身份与流式开关由适配器控制
    'model',
    'stream',
  ])
  if (protocol === 'chat_completions') {
    set.add('messages')
    set.add('tools')
    set.add('tool_choice')
    // 推理等级：Adapter 由 request.reasoningEffort 写入。
    set.add('reasoning_effort')
  } else if (protocol === 'responses') {
    set.add('input')
    set.add('instructions')
    set.add('tools')
    set.add('tool_choice')
    // 推理等级：Adapter 由 request.reasoningEffort 写入。
    set.add('reasoning')
  } else if (protocol === 'image_generations') {
    set.add('prompt')
    // 图片参数由 ImageGenerationProfile 单一管理，动态参数不重复定义，避免双源。
    set.add('n')
    set.add('size')
    set.add('quality')
    set.add('background')
    set.add('output_format')
  }
  return set
}

// 判断某路径是否命中受保护核心字段。
// extra_body.xxx 视为受保护字段 xxx（保持与顶层一致的保护语义）。
export function isProtectedRequestPath(protocol: ProviderProtocol, path: string): boolean {
  const segments = (path ?? '').trim().split('.')
  const leaf = segments[segments.length - 1]
  return getProtectedRequestPaths(protocol).has(leaf)
}

// 协议保留 path：核心字段（适配器必写）+ Image requestMapping 管理的字段位置
//（参考图写入位置 / response_format 位置）。动态参数不得占用，否则会与核心值 / 参考图 /
// response_format 冲突。Main（保存校验 + 运行期防御）与 Renderer（保存前即时反馈）共用同一份。
export function computeReservedRequestPaths(
  protocol: ProviderProtocol,
  imageProfile?: ImageGenerationParameterProfile
): Set<string> {
  const set = new Set<string>(getProtectedRequestPaths(protocol))
  if (protocol === 'image_generations' && imageProfile) {
    const mapping = imageProfile.requestMapping
    if (mapping?.inputImages?.path) set.add(mapping.inputImages.path.trim())
    const resp = mapping?.responseFormatParameter
    if (resp?.enabled && resp.path) set.add(resp.path.trim())
  }
  return set
}

// 请求构建前的运行期防御：动态参数重复 path / 撞保留字段 → 返回错误文案（绝不 last-write-wins）。
// 返回 null 表示通过。
export function findDynamicParameterConflict(
  resolved: ResolvedRequestParameter[],
  reserved: Set<string>
): string | null {
  const dup = findDuplicateResolvedPath(resolved)
  if (dup) return `参数「${dup.ids.join('」「')}」都指向字段「${dup.path}」，请修改其中一个。`
  const rc = findReservedPathConflict(resolved, reserved)
  if (rc) return `参数「${rc.id}」使用了协议保留字段「${rc.path}」。`
  return null
}

// ── 定义校验 ──

const VALID_TYPES: RequestParameterType[] = ['string', 'number', 'boolean', 'select']
const VALID_PLACEMENTS: RequestParameterPlacement[] = ['primary', 'advanced', 'hidden']

// 单个参数定义校验。返回 null 表示合法，否则返回面向用户的错误文案。
export function validateDefinition(def: DynamicRequestParameterDefinition): string | null {
  if (!def.id || !PARAMETER_ID_PATTERN.test(def.id)) {
    return '参数 ID 不能为空，且只能包含字母、数字、点、下划线、短横线'
  }
  if (!def.label || !def.label.trim()) return `参数「${def.id}」缺少显示名称`
  const pathErr = validateRequestPath(def.path)
  if (pathErr) return `参数「${def.label}」的字段路径无效：${pathErr}`
  if (!VALID_TYPES.includes(def.type)) return `参数「${def.label}」的类型无效`
  if (!VALID_PLACEMENTS.includes(def.placement)) return `参数「${def.label}」的显示位置无效`

  if (def.type === 'number') {
    if (def.min !== undefined && !Number.isFinite(def.min)) return `参数「${def.label}」的最小值无效`
    if (def.max !== undefined && !Number.isFinite(def.max)) return `参数「${def.label}」的最大值无效`
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
      return `参数「${def.label}」的最小值不能大于最大值`
    }
    if (def.step !== undefined && (!Number.isFinite(def.step) || def.step <= 0)) {
      return `参数「${def.label}」的步长必须为正数`
    }
  }
  if (def.type === 'select') {
    if (!def.options || def.options.length === 0) return `参数「${def.label}」为下拉类型但未配置候选项`
    const seen = new Set<string>()
    for (const opt of def.options) {
      if (!isOptionValueValid(opt)) return `参数「${def.label}」的候选项值无效`
      const key = `${typeof opt.value}:${String(opt.value)}`
      if (seen.has(key)) return `参数「${def.label}」的候选项值重复`
      seen.add(key)
    }
  }
  // hidden 参数应固定发送：必须提供 fixedValue，否则既不可见也不发送，毫无意义。
  if (def.placement === 'hidden' && def.fixedValue === undefined) {
    return `隐藏参数「${def.label}」必须设置固定值`
  }
  // fixedValue / defaultValue 的类型匹配校验。
  if (def.fixedValue !== undefined) {
    const err = validateValueAgainstType(def, def.fixedValue, true)
    if (err) return `参数「${def.label}」的固定值无效：${err}`
  }
  if (def.defaultValue !== undefined) {
    const err = validateValueAgainstType(def, def.defaultValue, true)
    if (err) return `参数「${def.label}」的默认值无效：${err}`
  }
  // required 参数第一版必须有 default/fixed，避免发送阶段阻塞。
  if (def.required && def.defaultValue === undefined && def.fixedValue === undefined) {
    return `必填参数「${def.label}」必须提供默认值或固定值`
  }
  return null
}

function isOptionValueValid(opt: RequestParameterOption): boolean {
  if (!opt || typeof opt.label !== 'string') return false
  const t = typeof opt.value
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return t !== 'number' || Number.isFinite(opt.value as number)
  }
  return false
}

// 值与其声明类型 / 约束是否匹配。strictOptions=true 时 select 值必须命中候选项。
// 返回 null 表示合法，否则返回面向用户的错误文案。
export function validateValueAgainstType(
  def: DynamicRequestParameterDefinition,
  value: unknown,
  strictOptions = true
): string | null {
  switch (def.type) {
    case 'string':
      return typeof value === 'string' ? null : `${def.label} 必须是字符串`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${def.label} 必须是布尔值`
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${def.label} 必须是有限数字`
      if (def.min !== undefined && value < def.min) return `${def.label} 不能小于 ${def.min}`
      if (def.max !== undefined && value > def.max) return `${def.label} 不能大于 ${def.max}`
      if (def.step !== undefined && def.step > 0) {
        // 允许浮点步长：以 min（或 0）为基准取模，容忍浮点误差。
        const base = def.min ?? 0
        const remainder = Math.abs((value - base) % def.step)
        const tolerance = 1e-9
        if (remainder > tolerance && Math.abs(remainder - def.step) > tolerance) {
          return `${def.label} 必须是 ${def.step} 的整数倍`
        }
      }
      return null
    }
    case 'select': {
      if (!def.options) return `${def.label} 未配置候选项`
      const match = def.options.some(
        (o) => o.value === value && typeof o.value === typeof value
      )
      return match ? null : `${def.label} 的值不在允许范围内`
    }
    default:
      return `${def.label} 的类型无效`
  }
}

// ── Profile 校验 ──
// Provider 保存时的权威校验（Main 会再跑一次）。返回 null 表示可保存。
// reservedPaths：协议保留 path（核心字段 + requestMapping 管理的字段），可选。
export function validateRequestParameterProfile(
  profile: RequestParameterProfile | undefined,
  protocol: ProviderProtocol,
  reservedPaths?: Iterable<string>
): string | null {
  if (!profile) return null
  const reserved = reservedPaths ? new Set(reservedPaths) : undefined
  const providerParams = profile.providerParameters ?? []
  if (providerParams.length > MAX_REQUEST_PARAMETERS) {
    return `Provider 级参数数量超过上限（最多 ${MAX_REQUEST_PARAMETERS} 个）`
  }

  const idError = validateDefinitionList(providerParams, protocol, 'Provider')
  if (idError) return idError

  // Provider 级 active 参数禁止指向重复 path。
  const pathError = validatePathUniqueness(providerParams)
  if (pathError) return pathError

  // Provider 级参数不得使用协议保留 path（核心字段由 protected 拦截；此处补 requestMapping 等）。
  if (reserved) {
    const rpErr = validateReservedPaths(providerParams, reserved, 'Provider')
    if (rpErr) return rpErr
  }

  const overrides = profile.modelOverrides ?? {}
  for (const [modelId, override] of Object.entries(overrides)) {
    if ((override.parameters ?? []).length > MAX_REQUEST_PARAMETERS) {
      return `模型级参数数量超过上限（最多 ${MAX_REQUEST_PARAMETERS} 个）`
    }
    const err = validateDefinitionList(override.parameters ?? [], protocol, '模型')
    if (err) return err
    const dpErr = validatePathUniqueness(override.parameters ?? [])
    if (dpErr) return dpErr
    if (reserved) {
      const rpErr = validateReservedPaths(override.parameters ?? [], reserved, '模型')
      if (rpErr) return rpErr
    }
    // 合并后冲突检测：各层单独合法，合并仍可能重复 path / 撞保留字段。
    const merged = resolveRequestParameters(profile, modelId)
    const dup = findDuplicateResolvedPath(merged.map((d) => ({ id: d.id, path: d.path, value: '' })))
    if (dup) {
      return `模型「${modelId}」合并后参数「${dup.ids.join('」「')}」都指向字段「${dup.path}」，请修改其中一个。`
    }
    if (reserved) {
      const rc = findReservedPathConflict(merged.map((d) => ({ id: d.id, path: d.path, value: '' })), reserved)
      if (rc) return `参数「${rc.id}」使用了协议保留字段「${rc.path}」。`
    }
  }

  return null
}

function validateReservedPaths(
  list: DynamicRequestParameterDefinition[],
  reserved: Set<string>,
  scope: string
): string | null {
  for (const def of list) {
    if (reserved.has(def.path.trim())) {
      return `${scope}级参数「${def.label}」使用了协议保留字段「${def.path}」。`
    }
  }
  return null
}

// 列表内：id 唯一 + 每个定义合法 + 未与协议核心字段冲突。
function validateDefinitionList(
  list: DynamicRequestParameterDefinition[],
  protocol: ProviderProtocol,
  scope: string
): string | null {
  const ids = new Set<string>()
  for (const def of list) {
    const err = validateDefinition(def)
    if (err) return err
    if (ids.has(def.id)) return `${scope}级参数 ID 重复：「${def.id}」`
    ids.add(def.id)
    if (isProtectedRequestPath(protocol, def.path)) {
      return `参数「${def.label}」的字段路径「${def.path}」由 OpenChat 协议核心参数管理，不能重复配置。`
    }
  }
  return null
}

// 同一 scope 内 active（hidden 也参与，因为 hidden 也会发送）参数禁止重复 path。
function validatePathUniqueness(list: DynamicRequestParameterDefinition[]): string | null {
  const paths = new Map<string, string>()
  for (const def of list) {
    const key = def.path.trim()
    const prev = paths.get(key)
    if (prev) return `参数「${prev}」与「${def.label}」使用了相同的字段路径「${key}」`
    paths.set(key, def.label)
  }
  return null
}

// ── resolve：Provider 级 + Model override 合并 ──
// 规则：
// 1. 先取 provider-level；
// 2. 应用 model override：同 id 覆盖、disabledParameterIds 删除、model-only 追加；
// 3. 保持稳定 order（被覆盖的留在原位，删除的移除，新追加的排在其后）；
// 4. 只按 id 合并，绝不按 label / path。
// 未配置 override 或 Provider 无参数 → 分别使用 provider-level / []。
export function resolveRequestParameters(
  profile: RequestParameterProfile | undefined,
  modelId: string | null
): DynamicRequestParameterDefinition[] {
  if (!profile) return []
  const providerParams = profile.providerParameters ?? []
  const override: RequestParameterModelOverride | undefined =
    modelId && profile.modelOverrides ? profile.modelOverrides[modelId] : undefined
  if (!override) return [...providerParams]

  const disabled = new Set(override.disabledParameterIds ?? [])
  const overridesById = new Map<string, DynamicRequestParameterDefinition>()
  for (const def of override.parameters ?? []) overridesById.set(def.id, def)

  const result: DynamicRequestParameterDefinition[] = []
  const providerIds = new Set<string>()

  for (const def of providerParams) {
    providerIds.add(def.id)
    if (disabled.has(def.id)) continue
    result.push(overridesById.get(def.id) ?? def)
  }

  // model-only 新参数：未被 disable 且不属于 provider 级的，追加到末尾。
  for (const def of override.parameters ?? []) {
    if (providerIds.has(def.id) || disabled.has(def.id)) continue
    result.push(def)
  }

  return result
}

// ── 应用：definitions + values → ResolvedRequestParameter[] ──
// - hidden + fixedValue → 一定发送 fixedValue；
// - editable：values 中不存在 id → omit；存在 → 校验后发送；
// - 绝不把 UI label 参与请求。
export interface ApplyParametersResult {
  resolved: ResolvedRequestParameter[]
  error: string | null
}

export function resolveParameterValues(
  definitions: DynamicRequestParameterDefinition[],
  values: RequestParameterValues,
  protocol?: ProviderProtocol
): ApplyParametersResult {
  const resolved: ResolvedRequestParameter[] = []
  for (const def of definitions) {
    // 请求构建前再次做安全检查（DB 旧值 / 手改 JSON / 未来 migration 都可能脏）：
    // 绝不让动态参数覆盖协议核心字段，也绝不写入非法 path。
    if (validateRequestPath(def.path) !== null) {
      return { resolved, error: `参数「${def.label}」的字段路径无效，已拒绝发送。` }
    }
    if (protocol && isProtectedRequestPath(protocol, def.path)) {
      return { resolved, error: `参数「${def.label}」使用了协议核心字段，已拒绝发送。` }
    }
    // hidden 固定值优先。
    if (def.fixedValue !== undefined) {
      const err = validateValueAgainstType(def, def.fixedValue)
      if (err) return { resolved, error: err }
      resolved.push({ id: def.id, path: def.path, value: def.fixedValue })
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(values, def.id)) {
      // unset → 不发送（也覆盖 defaultValue：第一版 defaultValue 不自动发送）。
      if (def.required) {
        return { resolved, error: `参数「${def.label}」为必填项，请设置后再发送。` }
      }
      continue
    }
    const value = values[def.id]
    if (value === undefined) continue
    const err = validateValueAgainstType(def, value)
    if (err) return { resolved, error: `参数「${def.label}」的值无效：${err}` }
    resolved.push({ id: def.id, path: def.path, value })
  }
  return { resolved, error: null }
}

// 把已解析的动态参数写入 request body。
// Adapter 侧最终注入调用：只按 path 写，不认识具体参数名。
export function applyResolvedParameters(
  body: Record<string, unknown>,
  resolved: ResolvedRequestParameter[]
): void {
  for (const p of resolved) {
    applyRequestField(body, p.path, p.value)
  }
}

// ── 合并后冲突检测（Provider 级 + Model override 合并之后，各层单独合法但合并可能冲突）──

// 已解析参数之间重复 path（例如 Provider A→foo，Model override 新增 B→foo）。
// 返回冲突路径与涉及 id；无冲突返回 null。
export function findDuplicateResolvedPath(
  resolved: ResolvedRequestParameter[]
): { path: string; ids: string[] } | null {
  const byPath = new Map<string, string[]>()
  for (const p of resolved) {
    const ids = byPath.get(p.path) ?? []
    ids.push(p.id)
    byPath.set(p.path, ids)
  }
  for (const [path, ids] of byPath) {
    if (ids.length > 1) return { path, ids }
  }
  return null
}

// 动态参数 path 与协议保留 path（核心字段 + requestMapping 管理的字段）冲突。
// reservedPaths 由调用方按协议 / Profile 动态计算（例如 Image 的参考图 / response_format 位置）。
export function findReservedPathConflict(
  resolved: ResolvedRequestParameter[],
  reservedPaths: Iterable<string>
): { path: string; id: string } | null {
  const reserved = new Set(reservedPaths)
  for (const p of resolved) {
    if (reserved.has(p.path)) return { path: p.path, id: p.id }
  }
  return null
}

// ── 反序列化容错 ──
// 旧库 / 手改 JSON / 未来 migration 都可能脏；非法定义一律丢弃，绝不写入畸形 path。
export function normalizeRequestParameterProfile(raw: unknown): RequestParameterProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const providerParameters = normalizeDefinitionList(obj.providerParameters)
  let modelOverrides: Record<string, RequestParameterModelOverride> | undefined

  if (obj.modelOverrides && typeof obj.modelOverrides === 'object') {
    const raw2 = obj.modelOverrides as Record<string, unknown>
    for (const [modelId, overrideRaw] of Object.entries(raw2)) {
      if (!overrideRaw || typeof overrideRaw !== 'object') continue
      const o = overrideRaw as Record<string, unknown>
      const parameters = normalizeDefinitionList(o.parameters)
      const disabledParameterIds = Array.isArray(o.disabledParameterIds)
        ? o.disabledParameterIds.filter((v): v is string => typeof v === 'string')
        : undefined
      if (parameters.length === 0 && (!disabledParameterIds || disabledParameterIds.length === 0)) continue
      if (!modelOverrides) modelOverrides = {}
      modelOverrides[modelId] = {
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(disabledParameterIds && disabledParameterIds.length > 0 ? { disabledParameterIds } : {}),
      }
    }
  }

  if (providerParameters.length === 0 && !modelOverrides) return undefined
  return {
    version: typeof obj.version === 'number' ? obj.version : REQUEST_PARAMETER_PROFILE_VERSION,
    providerParameters,
    ...(modelOverrides ? { modelOverrides } : {}),
  }
}

function normalizeDefinitionList(raw: unknown): DynamicRequestParameterDefinition[] {
  if (!Array.isArray(raw)) return []
  const out: DynamicRequestParameterDefinition[] = []
  for (const item of raw) {
    const def = normalizeDefinition(item)
    if (def) out.push(def)
  }
  return out
}

function normalizeDefinition(raw: unknown): DynamicRequestParameterDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.path !== 'string') return null
  if (validateRequestPath(o.path) !== null) return null
  const type = (typeof o.type === 'string' && VALID_TYPES.includes(o.type as RequestParameterType)
    ? o.type
    : 'string') as RequestParameterType
  const placement = (typeof o.placement === 'string' && VALID_PLACEMENTS.includes(o.placement as RequestParameterPlacement)
    ? o.placement
    : 'advanced') as RequestParameterPlacement

  const def: DynamicRequestParameterDefinition = {
    id: o.id,
    label: typeof o.label === 'string' ? o.label : o.id,
    path: o.path.trim(),
    type,
    placement,
  }
  if (typeof o.description === 'string') def.description = o.description
  if (typeof o.semantic === 'string') def.semantic = o.semantic
  if (o.required === true) def.required = true
  if (isScalar(o.defaultValue)) def.defaultValue = o.defaultValue
  if (isScalar(o.fixedValue)) def.fixedValue = o.fixedValue
  if (Number.isFinite(o.min)) def.min = Number(o.min)
  if (Number.isFinite(o.max)) def.max = Number(o.max)
  if (Number.isFinite(o.step)) def.step = Number(o.step)
  if (Array.isArray(o.options)) {
    const options: RequestParameterOption[] = []
    for (const opt of o.options) {
      if (opt && typeof opt === 'object') {
        const c = opt as Record<string, unknown>
        if (isScalar(c.value)) {
          options.push({ label: typeof c.label === 'string' ? c.label : String(c.value), value: c.value })
        }
      }
    }
    if (options.length > 0) def.options = options
  }
  return def
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}

// 清理 values：只保留当前 definitions 中存在的 id，并删除 undefined / 非法值。
// 用于 Conversation values 落库前的归一化与请求构建前的安全检查。
export function sanitizeParameterValues(
  definitions: DynamicRequestParameterDefinition[],
  values: RequestParameterValues | undefined
): RequestParameterValues {
  if (!values || typeof values !== 'object') return {}
  const byId = new Map(definitions.map((d) => [d.id, d]))
  const out: RequestParameterValues = {}
  for (const [id, value] of Object.entries(values)) {
    const def = byId.get(id)
    if (!def) continue
    if (value === undefined) continue
    if (validateValueAgainstType(def, value) !== null) continue
    out[id] = value
  }
  return out
}
