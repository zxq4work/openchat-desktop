import { describe, it, expect } from 'vitest'
import { formatMessageTime, formatFullMessageTime } from './messageTime'

// 全部使用本地时区构造 Date，断言不受测试机器时区影响。
// now 显式传入，避免依赖真实当前时间。
describe('formatMessageTime (relative date rules)', () => {
  const now = new Date(2026, 9, 27, 15, 30, 0).getTime() // 2026-10-27 15:30 本地

  it('今天 → 只显示 HH:mm', () => {
    expect(formatMessageTime(new Date(2026, 9, 27, 9, 14, 0).getTime(), now)).toBe('09:14')
    expect(formatMessageTime(new Date(2026, 9, 27, 15, 29, 59).getTime(), now)).toBe('15:29')
  })

  it('昨天 → 昨天 HH:mm（按自然日，不是 24 小时差）', () => {
    // 昨天 23:59 距 now 仅 15.5 小时，但属于上一自然日
    expect(formatMessageTime(new Date(2026, 9, 26, 23, 59, 0).getTime(), now)).toBe('昨天 23:59')
    // 昨天 00:00 距 now 已 39.5 小时，但仍是昨天
    expect(formatMessageTime(new Date(2026, 9, 26, 0, 0, 0).getTime(), now)).toBe('昨天 00:00')
  })

  it('今年更早 → MM-dd HH:mm', () => {
    expect(formatMessageTime(new Date(2026, 9, 25, 8, 5, 0).getTime(), now)).toBe('10-25 08:05')
    expect(formatMessageTime(new Date(2026, 0, 1, 0, 0, 0).getTime(), now)).toBe('01-01 00:00')
  })

  it('往年 → yyyy-MM-dd HH:mm', () => {
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 59, 0).getTime(), now)).toBe('2025-12-31 23:59')
  })

  it('跨午夜后 23:59 的「今天」变为「昨天」', () => {
    const ts = new Date(2026, 9, 27, 23, 59, 0).getTime()
    const beforeMidnight = new Date(2026, 9, 27, 23, 59, 30).getTime()
    const afterMidnight = new Date(2026, 9, 28, 0, 0, 30).getTime()
    expect(formatMessageTime(ts, beforeMidnight)).toBe('23:59')
    expect(formatMessageTime(ts, afterMidnight)).toBe('昨天 23:59')
  })

  it('DST 边界下的自然日判断仍正确（不再用 24 小时整除）', () => {
    // 昨天任意时刻在 now 为次日早间时都应判为昨天
    const nowMorning = new Date(2026, 9, 27, 0, 10, 0).getTime()
    expect(formatMessageTime(new Date(2026, 9, 26, 23, 50, 0).getTime(), nowMorning)).toBe('昨天 23:50')
  })

  it('缺失 / 非法时间戳返回 null', () => {
    expect(formatMessageTime(null, now)).toBeNull()
    expect(formatMessageTime(undefined, now)).toBeNull()
    expect(formatMessageTime(0, now)).toBeNull()
    expect(formatMessageTime(-1, now)).toBeNull()
    expect(formatMessageTime(Number.NaN, now)).toBeNull()
    expect(formatMessageTime(Number.POSITIVE_INFINITY, now)).toBeNull()
  })
})

describe('formatFullMessageTime (hover tooltip)', () => {
  it('完整本地时间精确到秒', () => {
    const ts = new Date(2026, 0, 5, 9, 7, 3).getTime()
    expect(formatFullMessageTime(ts)).toBe('2026-01-05 09:07:03')
  })

  it('字段补零', () => {
    const ts = new Date(2026, 11, 31, 0, 0, 0).getTime()
    expect(formatFullMessageTime(ts)).toBe('2026-12-31 00:00:00')
  })

  it('缺失 / 非法返回 null', () => {
    expect(formatFullMessageTime(null)).toBeNull()
    expect(formatFullMessageTime(0)).toBeNull()
    expect(formatFullMessageTime(Number.NaN)).toBeNull()
  })
})