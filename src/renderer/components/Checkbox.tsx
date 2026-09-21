import React from 'react'

// OpenChat 统一 Checkbox：外观完全由本组件控制，不依赖操作系统原生皮肤。
// 仍保留真实 <input type="checkbox">，键盘 / 屏幕阅读器语义不变；
// 勾选标记用 SVG 线条绘制（非文字字符 ✓），以适配 Electron 22 / Win7 / macOS 10.13.6。
export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  disabled?: boolean
  className?: string
  id?: string
  ariaLabel?: string
}

export function Checkbox({ checked, onChange, label, disabled, className, id, ariaLabel }: CheckboxProps) {
  const rootClass = `oc-checkbox${disabled ? ' oc-checkbox--disabled' : ''}${className ? ` ${className}` : ''}`
  return (
    <label className={rootClass}>
      <input
        className="oc-checkbox-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        id={id}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="oc-checkbox-box" aria-hidden="true">
        <svg className="oc-checkbox-mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      </span>
      {label != null && <span className="oc-checkbox-label">{label}</span>}
    </label>
  )
}
