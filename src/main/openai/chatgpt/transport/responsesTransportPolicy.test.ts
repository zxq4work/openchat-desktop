import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 纯函数 Transport Policy：不触达 electron / 网络 / env。
import {
  resolveEffectiveResponsesLite,
  requiresNonLiteTransport,
} from './responsesTransportPolicy'

describe('resolveEffectiveResponsesLite — 正式 Transport Policy', () => {
  // TEST 1
  it('TEST 1: Lite 模型 + none → effectiveResponsesLite=true', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: true, searchStrategy: 'none' })).toBe(true)
  })

  // TEST 2
  it('TEST 2: Lite 模型 + codex-hosted → effectiveResponsesLite=false（强制 Non-Lite）', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: true, searchStrategy: 'codex-hosted' })).toBe(false)
  })

  // TEST 3
  it('TEST 3: Lite 模型 + codex-standalone → effectiveResponsesLite=true（standalone 不需 Non-Lite）', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: true, searchStrategy: 'codex-standalone' })).toBe(true)
  })

  // TEST 4
  it('TEST 4: 非 Lite 模型 + none → false', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: false, searchStrategy: 'none' })).toBe(false)
  })

  // TEST 5
  it('TEST 5: 非 Lite 模型 + codex-hosted → false（非 Lite 模型任何策略都 Non-Lite）', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: false, searchStrategy: 'codex-hosted' })).toBe(false)
  })

  // TEST 5b：非 Lite 模型 + standalone → false
  it('非 Lite 模型 + codex-standalone → false', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: false, searchStrategy: 'codex-standalone' })).toBe(false)
  })

  // TEST 15
  it('TEST 15: 不变式 — 只要 codex-hosted，effectiveResponsesLite 永不为 true', () => {
    for (const modelWants of [true, false]) {
      expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: modelWants, searchStrategy: 'codex-hosted' })).toBe(false)
    }
  })

  // TEST 15b：requiresNonLiteTransport 当前只对 codex-hosted 为 true
  it('requiresNonLiteTransport 仅对 codex-hosted 为 true（未扩展未验证能力）', () => {
    expect(requiresNonLiteTransport({ searchStrategy: 'codex-hosted' })).toBe(true)
    expect(requiresNonLiteTransport({ searchStrategy: 'none' })).toBe(false)
    expect(requiresNonLiteTransport({ searchStrategy: 'codex-standalone' })).toBe(false)
    expect(requiresNonLiteTransport({ searchStrategy: 'openchat-custom' })).toBe(false)
    // 未验证的能力组合不得被纳入 Non-Lite requirement
    expect(requiresNonLiteTransport({ searchStrategy: 'image_generation' })).toBe(false)
    expect(requiresNonLiteTransport({ searchStrategy: 'file_search' })).toBe(false)
  })

  it('未知 searchStrategy → 不触发 Non-Lite（回落模型 metadata）', () => {
    expect(resolveEffectiveResponsesLite({ modelWantsResponsesLite: true, searchStrategy: 'future-strategy' })).toBe(true)
  })
})

describe('Transport Policy 静态约束', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src/main/openai/chatgpt/transport/responsesTransportPolicy.ts'), 'utf8')
  // 剥离注释，避免注释里对「禁止 slug 特判」的文字描述造成误判。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  // TEST 10
  it('TEST 10: 不含任何 model slug 特判', () => {
    expect(code).not.toMatch(/gpt/i)
    expect(code).not.toMatch(/\b(luna|astra|terra|reserve)\b/i)
    expect(code).not.toMatch(/startsWith\s*\(/)
    expect(code).not.toMatch(/\.includes\s*\(\s*['"]gpt/i)
  })

  // TEST 11
  it('TEST 11: 不依赖任何 env flag（无需环境变量即可正确选择 Non-Lite）', () => {
    expect(code).not.toContain('process.env')
    expect(code).not.toMatch(/OPENCHAT_DEBUG/)
    expect(code).not.toMatch(/isDevelopment/)
  })
})

describe('搜索关闭时 Provider History 回放门控（静态守卫）', () => {
  const serviceSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/main/openai/chatgpt/ChatGPTConversationService.ts'), 'utf8')

  // TEST 12：搜索关闭的 Lite turn 不得把历史 hosted web_search_call 混入 wire input。
  // 该行为由 buildCanonicalRequest 的 skipWebSearchHistory 门控保证：门控存在时整块
  // providerPayloadJson 解析被跳过，因此 web_search_call 不会进入 messages。
  it('TEST 12: buildCanonicalRequest 仍以 skipWebSearchHistory 门控 providerPayloadJson 回放', () => {
    expect(serviceSrc).toMatch(/if\s*\(\s*msg\.providerPayloadJson\s*&&\s*!skipWebSearchHistory\s*\)/)
  })

  it('runGenerationDirect 仍以 skipWebSearchHistory=true 构造请求（搜索关闭路径）', () => {
    expect(serviceSrc).toMatch(/noSearchInstructions[^\n]*\n[^\n]*buildCanonicalRequest\([^)]*,\s*true\s*,\s*effectiveResponsesLite\s*\)/)
  })
})
