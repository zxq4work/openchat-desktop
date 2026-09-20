import React from 'react'

interface Props {
  disabled?: boolean
  onClick: () => void
}

// Composer 左下角的「添加图片」按钮，风格与现有 toggle 一致。
export function AttachButton({ disabled, onClick }: Props) {
  return (
    <button
      type="button"
      className="attach-btn"
      onClick={onClick}
      disabled={disabled}
      title="添加图片"
      aria-label="添加图片"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3v10" />
        <path d="M3 8h10" />
      </svg>
    </button>
  )
}
