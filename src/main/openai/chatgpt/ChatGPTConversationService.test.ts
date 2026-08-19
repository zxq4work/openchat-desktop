import { describe, it, expect, beforeEach } from 'vitest'

/**
 * 说明：ChatGPTConversationService 依赖真实的 StorageService（sql.js WASM），
 * 在纯 Node 测试环境下需要加载 WASM，本测试文件仅验证关键逻辑（输入构造、标题派生）。
 * 完整集成测试在 Electron main process 中通过 mock provider 运行。
 */

// 标题派生逻辑（与 ChatGPTConversationService.deriveTitle 相同）
function deriveTitle(text: string, maxLength = 40): string {
  const trimmed = text.trim().replace(/\n/g, ' ')
  return trimmed.slice(0, maxLength) || '新对话'
}

// 输入构造逻辑（从 segment 消息 + 新用户文本）
function buildInput(
  segmentMessages: Array<{ role: 'user' | 'assistant'; content: string; status: string }>,
  newUserText: string
): Array<{ role: string; content: string }> {
  const input: Array<{ role: string; content: string }> = []

  for (const msg of segmentMessages) {
    if (msg.status === 'completed' && msg.content) {
      input.push({ role: msg.role, content: msg.content })
    }
  }

  if (!input.some((item) => item.role === 'user' && item.content === newUserText)) {
    input.push({ role: 'user', content: newUserText })
  }

  return input
}

describe('deriveTitle', () => {
  it('derives title from first line', () => {
    expect(deriveTitle('如何学习 TypeScript？')).toBe('如何学习 TypeScript？')
  })

  it('replaces newlines with spaces', () => {
    expect(deriveTitle('第一行\n第二行\n第三行')).toBe('第一行 第二行 第三行')
  })

  it('truncates to max length', () => {
    const long = 'a'.repeat(100)
    expect(deriveTitle(long)).toHaveLength(40)
  })

  it('returns default for empty input', () => {
    expect(deriveTitle('   ')).toBe('新对话')
  })
})

describe('buildInput', () => {
  it('builds input from completed messages only', () => {
    const messages = [
      { role: 'user' as const, content: 'Q1', status: 'completed' },
      { role: 'assistant' as const, content: 'A1', status: 'completed' },
      { role: 'assistant' as const, content: '', status: 'streaming' },
    ]

    const input = buildInput(messages, 'Q2')
    expect(input).toHaveLength(3)
    expect(input[0]).toEqual({ role: 'user', content: 'Q1' })
    expect(input[1]).toEqual({ role: 'assistant', content: 'A1' })
    expect(input[2]).toEqual({ role: 'user', content: 'Q2' })
  })

  it('excludes failed messages', () => {
    const messages = [
      { role: 'user' as const, content: 'Q1', status: 'completed' },
      { role: 'assistant' as const, content: 'partial', status: 'failed' },
    ]

    const input = buildInput(messages, 'Q2')
    expect(input).toHaveLength(2)
    expect(input[0]).toEqual({ role: 'user', content: 'Q1' })
    expect(input[1]).toEqual({ role: 'user', content: 'Q2' })
  })

  it('deduplicates new user text', () => {
    const messages = [
      { role: 'user' as const, content: 'Q1', status: 'completed' },
    ]

    const input = buildInput(messages, 'Q1')
    expect(input).toHaveLength(1)
    expect(input[0]).toEqual({ role: 'user', content: 'Q1' })
  })
})