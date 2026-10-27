import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { copyTextAsync } from '../../packages/clipboard'
import { formatMessageTime, formatFullMessageTime } from '../../packages/messageTime'

// 共享「当前时间」时钟：所有时间戳共用一份，在下一个本地午夜触发刷新，
// 保证跨越午夜后「今天 / 昨天」等相对日期自动更新（无需重新加载会话）。
let currentNow = Date.now()
const nowListeners = new Set<() => void>()
let midnightTimer: ReturnType<typeof setTimeout> | null = null

function scheduleMidnightRefresh() {
  if (midnightTimer) clearTimeout(midnightTimer)
  const d = new Date(currentNow)
  const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  // +1s 缓冲：避免定时器恰好落在午夜前一刻，导致 dayDiff 仍为 0
  midnightTimer = setTimeout(refreshNow, nextMidnight - currentNow + 1000)
}

function refreshNow() {
  currentNow = Date.now()
  for (const listener of nowListeners) listener()
  scheduleMidnightRefresh()
}

function handleVisibilityChange() {
  // 休眠 / 后台可能推迟定时器；回到前台时补一次刷新
  if (document.visibilityState === 'visible') refreshNow()
}

function subscribeNow(listener: () => void) {
  nowListeners.add(listener)
  if (nowListeners.size === 1) {
    currentNow = Date.now()
    scheduleMidnightRefresh()
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  return () => {
    nowListeners.delete(listener)
    if (nowListeners.size === 0) {
      if (midnightTimer) {
        clearTimeout(midnightTimer)
        midnightTimer = null
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }
}

function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => currentNow)
}

interface Props {
  // 仅复制当前消息正文（原始 Markdown / 纯文本），不含角色、时间等元信息。
  content: string
  // 真实消息时间（用户 = 发送时间，AI = 完成时间）。缺失时不展示时间，仅保留复制按钮。
  timestamp: number | null | undefined
  align: 'left' | 'right'
}

// 消息底部：时间 + 单条复制。时间与复制按钮同一行，用户消息右对齐、AI 消息左对齐。
export function MessageFooter({ content, timestamp, align }: Props) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    const ok = await copyTextAsync(content)
    if (!ok) return
    setCopied(true)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), 2000)
  }, [content])

  const now = useNow()
  const timeLabel = formatMessageTime(timestamp, now)
  const fullTimeLabel = formatFullMessageTime(timestamp)
  const canCopy = content.length > 0
  if (!timeLabel && !canCopy) return null

  return (
    <div className={`message-footer message-footer--${align}`}>
      {timeLabel && <span className="message-time" title={fullTimeLabel ?? undefined}>{timeLabel}</span>}
      {canCopy && (
        <button
          type="button"
          className="message-copy-button"
          onClick={handleCopy}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : '复制消息'}
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}
    </div>
  )
}