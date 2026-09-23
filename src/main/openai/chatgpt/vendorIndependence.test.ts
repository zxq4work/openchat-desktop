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
})
