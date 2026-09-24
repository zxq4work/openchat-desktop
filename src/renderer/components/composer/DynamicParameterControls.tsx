import React, { useEffect, useState } from 'react'
import { Dropdown, type DropdownOption } from '../Dropdown'
import { Checkbox } from '../Checkbox'
import { validateValueAgainstType } from '../../../shared/request-parameters/requestParameters'
import type {
  DynamicRequestParameterDefinition,
  RequestParameterPlacement,
  RequestParameterValues,
} from '../../../shared/types/provider'

// 通用动态请求参数控件：Chat Composer 与 ImageComposer 共用。
// 完全由 definitions 驱动，绝不硬编码任何具体参数名（Steps / MaxTokens / Seed …）。
// placement 决定只渲染哪一组：
// - primary：直接显示在 Composer
// - advanced：仅在「高级参数」展开后显示
// - hidden：永不渲染（其值由 fixedValue 在 Main 侧固定注入）
//
// 值语义：unset（key 不存在）→ 不发送该字段。这里绝不把「默认」写成 0 / "default"。

const SELECT_DEFAULT_SENTINEL = '__default__'

interface DynamicParameterControlsProps {
  definitions: DynamicRequestParameterDefinition[]
  values: RequestParameterValues
  placement: RequestParameterPlacement
  onChange: (id: string, value: string | number | boolean) => void
  onUnset: (id: string) => void
  disabled?: boolean
  className?: string
}

// select 的 option value（string | number | boolean）编码/解码为 Dropdown 需要的 string，
// 保留类型信息，避免 "20" 与 20 混淆。
function encodeOptionValue(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`
}
function decodeOptionValue(encoded: string): string | number | boolean | undefined {
  const sep = encoded.indexOf(':')
  if (sep < 0) return undefined
  const type = encoded.slice(0, sep)
  const raw = encoded.slice(sep + 1)
  if (type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (type === 'boolean') return raw === 'true'
  return raw
}

function selectOptionsFor(def: DynamicRequestParameterDefinition): DropdownOption[] {
  const opts: DropdownOption[] = [{ value: SELECT_DEFAULT_SENTINEL, label: '默认' }]
  for (const o of def.options ?? []) {
    opts.push({ label: o.label, value: encodeOptionValue(o.value) })
  }
  return opts
}

export function DynamicParameterControls({
  definitions,
  values,
  placement,
  onChange,
  onUnset,
  disabled,
  className,
}: DynamicParameterControlsProps) {
  // number / string 的本地文本态：允许「空」（= unset）与中间输入态（如 "1."）。
  // 只在提交为合法值时回写父级，避免把不完整输入当成值。
  const [textDraft, setTextDraft] = useState<Record<string, string>>({})

  // definitions / values 变化（切换 Provider / Model）时同步文本态。
  useEffect(() => {
    setTextDraft((prev) => {
      const next: Record<string, string> = {}
      for (const def of definitions) {
        if (def.type !== 'number' && def.type !== 'string') continue
        if (Object.prototype.hasOwnProperty.call(values, def.id)) {
          next[def.id] = String(values[def.id])
        } else if (prev[def.id] !== undefined) {
          // 保留用户正在输入但尚未提交的中间态（如 "1."）——仅当该值仍未提交时。
          next[def.id] = prev[def.id]
        }
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitions, values])

  const visible = definitions.filter((d) => d.placement === placement && d.placement !== 'hidden')
  if (visible.length === 0) return null

  const commitNumber = (def: DynamicRequestParameterDefinition, raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      onUnset(def.id)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return
    onChange(def.id, n)
  }

  const commitString = (def: DynamicRequestParameterDefinition, raw: string) => {
    // 第一版：空字符串 = unset（Provider 真需要空串时以后再加 allowEmpty）。
    if (raw === '') {
      onUnset(def.id)
      return
    }
    onChange(def.id, raw)
  }

  return (
    <div className={`dynamic-params${className ? ` ${className}` : ''}`}>
      {visible.map((def) => {
        const isSet = Object.prototype.hasOwnProperty.call(values, def.id)
        const value = values[def.id]
        const inlineError = isSet ? validateValueAgainstType(def, value) : null
        return (
          <div key={def.id} className="dynamic-param-row" title={def.description || undefined}>
            <span className="dynamic-param-label">{def.label}</span>
            {renderControl(def, {
              isSet,
              value,
              disabled: !!disabled,
              textDraft,
              onTextChange: (raw) => setTextDraft((prev) => ({ ...prev, [def.id]: raw })),
              onCommitNumber: (raw) => commitNumber(def, raw),
              onCommitString: (raw) => commitString(def, raw),
              onChange,
              onUnset,
            })}
            {isSet && (
              <button
                type="button"
                className="dynamic-param-reset"
                onClick={() => onUnset(def.id)}
                disabled={disabled}
                title="重置为默认（不发送）"
              >
                默认
              </button>
            )}
            {inlineError && <span className="dynamic-param-error">{inlineError}</span>}
          </div>
        )
      })}
    </div>
  )
}

// 组合控件：primary 参数直接内联显示；advanced 参数折叠在「高级参数」展开区。
// 无任何可见参数（无 primary 且无 advanced）→ 整体不渲染（连「高级参数」入口都不出现）。
export function DynamicParameterSection({
  definitions,
  values,
  onChange,
  onUnset,
  disabled,
}: {
  definitions: DynamicRequestParameterDefinition[]
  values: RequestParameterValues
  onChange: (id: string, value: string | number | boolean) => void
  onUnset: (id: string) => void
  disabled?: boolean
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const hasPrimary = definitions.some((d) => d.placement === 'primary')
  const hasAdvanced = definitions.some((d) => d.placement === 'advanced')

  // 切换 Provider / Model 后若不再有高级参数，自动收起，避免残留展开态。
  useEffect(() => {
    if (!hasAdvanced) setAdvancedOpen(false)
  }, [hasAdvanced])

  if (!hasPrimary && !hasAdvanced) return null

  const shared = { values, onChange, onUnset, disabled }

  return (
    <div className="dynamic-params-section">
      <DynamicParameterControls definitions={definitions} placement="primary" {...shared} />
      {hasAdvanced && (
        <div className="dynamic-params-advanced">
          <button
            type="button"
            className="dynamic-params-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            <svg
              className={`dynamic-params-chevron${advancedOpen ? ' dynamic-params-chevron--open' : ''}`}
              width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span>高级参数</span>
          </button>
          {advancedOpen && (
            <DynamicParameterControls definitions={definitions} placement="advanced" {...shared} />
          )}
        </div>
      )}
    </div>
  )
}

interface RenderCtx {
  isSet: boolean
  value: string | number | boolean | undefined
  disabled: boolean
  textDraft: Record<string, string>
  onTextChange: (raw: string) => void
  onCommitNumber: (raw: string) => void
  onCommitString: (raw: string) => void
  onChange: (id: string, value: string | number | boolean) => void
  onUnset: (id: string) => void
}

function renderControl(def: DynamicRequestParameterDefinition, ctx: RenderCtx): React.ReactNode {
  switch (def.type) {
    case 'boolean':
      // 复用项目自定义 Checkbox（非系统原生）。设置后即为 true / false，重置按钮回到 unset。
      return (
        <Checkbox
          checked={ctx.value === true}
          disabled={ctx.disabled}
          onChange={(checked) => ctx.onChange(def.id, checked)}
          label={null}
          ariaLabel={def.label}
          className="dynamic-param-boolean"
        />
      )

    case 'select':
      return (
        <Dropdown
          className="dynamic-param-select"
          value={ctx.isSet ? encodeOptionValue(ctx.value as string | number | boolean) : SELECT_DEFAULT_SENTINEL}
          options={selectOptionsFor(def)}
          disabled={ctx.disabled}
          onChange={(encoded) => {
            if (encoded === SELECT_DEFAULT_SENTINEL) {
              ctx.onUnset(def.id)
              return
            }
            const decoded = decodeOptionValue(encoded)
            if (decoded !== undefined) ctx.onChange(def.id, decoded)
          }}
          ariaLabel={def.label}
          placeholder="默认"
        />
      )

    case 'number':
      return (
        <input
          className="dynamic-param-input"
          type="number"
          value={ctx.textDraft[def.id] ?? ''}
          min={def.min}
          max={def.max}
          step={def.step ?? 'any'}
          disabled={ctx.disabled}
          placeholder="默认"
          onChange={(e) => {
            ctx.onTextChange(e.target.value)
            ctx.onCommitNumber(e.target.value)
          }}
          aria-label={def.label}
        />
      )

    case 'string':
    default:
      return (
        <input
          className="dynamic-param-input"
          type="text"
          value={ctx.textDraft[def.id] ?? ''}
          disabled={ctx.disabled}
          placeholder="默认"
          onChange={(e) => {
            ctx.onTextChange(e.target.value)
            ctx.onCommitString(e.target.value)
          }}
          aria-label={def.label}
        />
      )
  }
}
