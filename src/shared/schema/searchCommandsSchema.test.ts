import { describe, it, expect } from 'vitest'
import { SEARCH_COMMANDS_JSON_SCHEMA } from './searchCommandsSchema'

// web.run 的 open 命令必须同时暴露两种 ref_id 语义：
//   1. search-result reference（如 turn0search0）
//   2. fully-qualified HTTP/HTTPS URL
// 一旦退化成「只允许搜索结果 ref」，模型就会先 search_query 再去 open，
// 导致用户直接提供 URL 时被错误地重新搜索。

describe('SEARCH_COMMANDS_JSON_SCHEMA.open', () => {
  const schema = SEARCH_COMMANDS_JSON_SCHEMA as unknown as {
    properties: {
      open?: {
        type: string
        description: string
        items: {
          required: string[]
          properties: {
            ref_id: { type: string; description: string; format?: string }
          }
        }
      }
    }
  }

  it('exposes the open command', () => {
    expect(schema.properties.open).toBeDefined()
  })

  it('declares open supports both search-result reference and fully-qualified URL', () => {
    const description = schema.properties.open!.description.toLowerCase()
    expect(description).toContain('search-result reference')
    expect(description).toContain('fully-qualified')
    expect(description).toContain('http/https')
    expect(description).toContain('url')
  })

  it('keeps ref_id as a plain string supporting turn0search0 (no format: uri)', () => {
    const refId = schema.properties.open!.items.properties.ref_id
    expect(refId.type).toBe('string')
    // 不允许把 ref_id 限制成纯 URL —— turn0search0 仍必须合法
    expect(refId.format).toBeUndefined()
  })

  it('describes ref_id as accepting both a reference and a URL', () => {
    const refIdDescription = schema.properties.open!.items.properties.ref_id.description.toLowerCase()
    expect(refIdDescription).toContain('search-result reference')
    expect(refIdDescription).toContain('http/https')
    expect(refIdDescription).toContain('url')
  })
})
