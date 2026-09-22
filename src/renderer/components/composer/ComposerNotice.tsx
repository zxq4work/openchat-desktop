import React from 'react'

// 统一的 Composer 提示条（Chat / Image 共用同一视觉组件）。
// 每个 Composer 同一时刻只渲染一个 notice slot，避免多种提示样式并存。
//
// variant 语义：
//   warning — 可恢复的配置类问题（binding 失效 / 模型不可用 / 参考图能力不匹配）
//   error   — 运行时错误（网络 / API / IPC / 生成失败）
//   info    — 中性提示（如「尚未配置服务」）
// 三者结构完全一致，仅颜色不同。
export type ComposerNoticeVariant = 'warning' | 'error' | 'info'

export interface ComposerNoticeData {
  variant: ComposerNoticeVariant
  message: string
}

interface Props {
  variant: ComposerNoticeVariant
  children: React.ReactNode
}

export function ComposerNotice({ variant, children }: Props) {
  return (
    <div className={`composer-notice composer-notice--${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
      <span className="composer-notice-icon" aria-hidden="true">
        {variant === 'error' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : variant === 'warning' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        )}
      </span>
      <span className="composer-notice-text">{children}</span>
    </div>
  )
}
