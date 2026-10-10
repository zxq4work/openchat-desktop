import { describe, it, expect } from 'vitest'
import { validateSearchCommands } from './searchCommandsValidation'
import type { SearchCommands } from '../types/webSearch'

// web.run 命令参数校验：拦下已知不受支持的字段（weather.date），
// 但绝不误拒合法命令（search_query / open / 以及其它未知命令族）。

describe('validateSearchCommands', () => {
  it('weather(location) 合法', () => {
    const commands: SearchCommands = { weather: [{ location: 'Beijing' }] }
    expect(validateSearchCommands(commands).ok).toBe(true)
  })

  it('weather(location, start, duration) 合法', () => {
    const commands: SearchCommands = {
      weather: [{ location: 'San Francisco, CA', start: '2026-10-10', duration: 3 }],
    }
    expect(validateSearchCommands(commands).ok).toBe(true)
  })

  it('weather 中出现 date → 拒绝，且报出字段名', () => {
    const commands = { weather: [{ location: 'Beijing', date: '2026-10-10' }] } as unknown as SearchCommands
    const result = validateSearchCommands(commands)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('weather[0].date')
  })

  it('weather 缺少 location → 拒绝', () => {
    const commands = { weather: [{ start: '2026-10-10' }] } as unknown as SearchCommands
    const result = validateSearchCommands(commands)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('location is required')
  })

  it('weather.location 非字符串 → 拒绝', () => {
    const commands = { weather: [{ location: 123 }] } as unknown as SearchCommands
    expect(validateSearchCommands(commands).ok).toBe(false)
  })

  it('weather.start 非字符串 / duration 非数字 → 拒绝', () => {
    expect(validateSearchCommands({ weather: [{ location: 'X', start: 5 }] } as unknown as SearchCommands).ok).toBe(false)
    expect(validateSearchCommands({ weather: [{ location: 'X', duration: '3' }] } as unknown as SearchCommands).ok).toBe(false)
  })

  it('search_query 不受 weather 校验影响', () => {
    const commands: SearchCommands = { search_query: [{ q: '北京天气' }] }
    expect(validateSearchCommands(commands).ok).toBe(true)
  })

  it('open 命令不被误拒', () => {
    const commands: SearchCommands = { open: [{ ref_id: 'https://example.com' }] }
    expect(validateSearchCommands(commands).ok).toBe(true)
  })

  it('无 weather 字段（空命令）合法', () => {
    expect(validateSearchCommands({}).ok).toBe(true)
  })

  it('未知命令族（finance/sports/time）不在当前校验范围，不误拒', () => {
    const commands = {
      finance: [{ ticker: 'AAPL', date: '2026-10-10' }],
      time: [{ location: 'Beijing', date: '2026-10-10' }],
    } as unknown as SearchCommands
    expect(validateSearchCommands(commands).ok).toBe(true)
  })
})
