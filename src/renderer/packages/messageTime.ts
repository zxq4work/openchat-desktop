// 消息时间显示：仅用于展示既有消息时间字段（用户 = createdAt，AI = updatedAt），
// 绝不在此处生成「当前时间」冒充真实消息时间。
// `now` 只用于判断「今天 / 昨天」等相对日期，不参与显示时间的取值。

const pad = (n: number) => String(n).padStart(2, '0')

function isValidTimestamp(timestamp: number | null | undefined): timestamp is number {
  return timestamp !== null && timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0
}

// 本地自然日的零点时间（毫秒），用于按日历日而非 24/48 小时差判断昨天。
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// 完整本地时间：YYYY-MM-DD HH:mm:ss（用于鼠标悬停提示）
export function formatFullMessageTime(timestamp: number | null | undefined): string | null {
  if (!isValidTimestamp(timestamp)) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// 相对日期显示：
//   今天     → HH:mm
//   昨天     → 昨天 HH:mm
//   今年更早 → MM-dd HH:mm
//   往年     → YYYY-MM-DD HH:mm
export function formatMessageTime(
  timestamp: number | null | undefined,
  now: number = Date.now()
): string | null {
  if (!isValidTimestamp(timestamp)) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null

  const nowDate = new Date(now)
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  // 按本地自然日差判断：DST 下两地日零点差可能不是整 86400000ms，故用取整。
  const dayDiff = Math.round(
    (startOfLocalDay(nowDate) - startOfLocalDay(date)) / 86400000
  )

  if (dayDiff === 0) return hm
  if (dayDiff === 1) return `昨天 ${hm}`
  if (date.getFullYear() === nowDate.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`
}
