import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// TEST 3: catalog version 与 vendor Codex 解耦。
// 用静态读取证明 model catalog 相关源码不 import / 引用 vendor 与 CODEX_VERSION。
// 断言前剥离注释，避免注释里对"解耦要求"的文字描述造成误判。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('vendor independence (model catalog)', () => {
  const files = [
    'src/main/openai/chatgpt/models/modelCatalogDiscovery.ts',
    'src/main/openai/chatgpt/models/ChatGPTModelService.ts',
    'src/main/openai/chatgpt/transport/ChatGPTCodexClient.ts',
  ]

  it('catalog source files never reference vendor/ or CODEX_VERSION', () => {
    for (const rel of files) {
      const abs = path.resolve(process.cwd(), rel)
      const content = stripComments(fs.readFileSync(abs, 'utf8'))
      expect(content, rel).not.toMatch(/vendor\/openai\/codex/)
      expect(content, rel).not.toMatch(/CODEX_VERSION/)
      expect(content, rel).not.toMatch(/protocolSchemaVersion/)
      expect(content, rel).not.toMatch(/codex-0\.148/)
    }
  })

  it('TEST 14: discovery sentinel is the declared 99.99.99', async () => {
    const mod = await import('./models/modelCatalogDiscovery')
    expect(mod.CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL).toBe('99.99.99')
  })

  // 遗留 AppServer/vendor 清理后的护栏：production source（非测试）不再出现
  // Codex 版本号、vendor 路径、legacy provider 开关与 CODEX_* 常量。
  // 断言前剥离注释，且跳过 *.test.ts（本文件自身含这些字面量）。
  it('production source has no legacy Codex 0.148 / appserver references', () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const offenders: string[] = []
    const patterns: Array<[string, RegExp]> = [
      ['codex-0.148.0', /codex-0\.148\.0/],
      ['vendor/openai/codex', /vendor\/openai\/codex/],
      ['OPENCHAT_PROVIDER=appserver', /OPENCHAT_PROVIDER\s*[=:]\s*['"]?appserver/],
      ['CODEX_VERSION', /\bCODEX_VERSION\b/],
      ['CODEX_TAG', /\bCODEX_TAG\b/],
      ['CODEX_COMMIT', /\bCODEX_COMMIT\b/],
    ]

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(abs)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
        const content = stripComments(fs.readFileSync(abs, 'utf8'))
        for (const [label, re] of patterns) {
          if (re.test(content)) {
            offenders.push(`${path.relative(process.cwd(), abs)} → ${label}`)
          }
        }
      }
    }

    walk(srcRoot)
    expect(offenders).toEqual([])
  })
})
