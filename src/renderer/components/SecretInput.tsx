import React, { useCallback, useState } from 'react'
import { resolveInputType } from '../packages/secretInput'

interface SecretInputProps {
  /** 真实值（由调用方持有）。组件不生成任何掩码。 */
  value: string
  onChange: (next: string) => void
  placeholder?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

// 内联 SVG 图标，跟随 currentColor，不引入任何图标依赖。
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

// 受控密码输入框：value 始终是调用方提供的真实值。
// Eye 仅切换原生 input 的 type（password ⇄ text），不生成任何星号/圆点，不触发任何 IPC。
export function SecretInput(props: SecretInputProps) {
  const { value, onChange, placeholder, disabled, id } = props
  const [visible, setVisible] = useState(false)

  const handleToggle = useCallback(() => {
    setVisible((v) => !v)
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value)
    },
    [onChange]
  )

  return (
    <div className="secret-input">
      <input
        id={id}
        className="provider-input secret-input__field"
        type={resolveInputType(visible)}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={props['aria-label']}
      />
      <button
        type="button"
        className="secret-input__toggle"
        onClick={handleToggle}
        disabled={disabled}
        aria-label={visible ? 'Hide API key' : 'Show API key'}
        title={visible ? '隐藏' : '显示'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}
