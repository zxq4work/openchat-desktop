import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 静态源码审计：确保 discovery 迁移后旧架构常量 / release-version 硬编码 / 实验 env
// 不会重新出现在 production source 中。
//
// 仅扫描 production 源码（src/**），排除 *.test.ts 与 fixtures（fixture 中的
// minimal_client_version='0.155.0' 是模拟服务器 metadata，允许存在）。
function listProductionSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue
      out.push(...listProductionSources(abs))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    out.push(abs)
  }
  return out
}

const ROOT = process.cwd()
const PRODUCTION_SOURCES = listProductionSources(path.join(ROOT, 'src'))

// 剥离注释：避免注释里对旧语义 / 解耦要求的文字描述造成误判。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function readCode(rel: string): string {
  return stripComments(fs.readFileSync(path.resolve(ROOT, rel), 'utf8'))
}

describe('catalog discovery static audit', () => {
  it('TEST 10: no production source references the old catalog constants', () => {
    for (const abs of PRODUCTION_SOURCES) {
      const code = stripComments(fs.readFileSync(abs, 'utf8'))
      expect(code, abs).not.toMatch(/CHATGPT_MODEL_CATALOG_CLIENT_VERSION/)
      expect(code, abs).not.toMatch(/CHATGPT_MODEL_CATALOG_FALLBACK_VERSION/)
      expect(code, abs).not.toMatch(/OPENCHAT_CHATGPT_MODEL_CATALOG_VERSION/)
    }
  })

  it('TEST 11: no production source uses 0.154.0 / 0.155.0 as a catalog runtime constant', () => {
    for (const abs of PRODUCTION_SOURCES) {
      const code = stripComments(fs.readFileSync(abs, 'utf8'))
      expect(code, abs).not.toMatch(/0\.154\.0/)
      expect(code, abs).not.toMatch(/0\.155\.0/)
    }
  })

  it('TEST 12: the only catalog discovery literal is 99.99.99, named with DISCOVERY/SENTINEL', () => {
    const hits: string[] = []
    for (const abs of PRODUCTION_SOURCES) {
      const code = stripComments(fs.readFileSync(abs, 'utf8'))
      if (code.includes('99.99.99')) hits.push(abs)
    }
    // 只允许出现在 discovery sentinel 定义文件中
    expect(hits).toEqual([path.join(ROOT, 'src/main/openai/chatgpt/models/modelCatalogDiscovery.ts')])
    const sentinel = readCode('src/main/openai/chatgpt/models/modelCatalogDiscovery.ts')
    expect(sentinel).toMatch(/CHATGPT_MODEL_CATALOG_DISCOVERY_SENTINEL/)
    expect(sentinel).toMatch(/'99\.99\.99'/)
  })

  it('TEST 15: negotiation experiment env / hook has been removed', () => {
    for (const abs of PRODUCTION_SOURCES) {
      const code = fs.readFileSync(abs, 'utf8')
      expect(code, abs).not.toMatch(/OPENCHAT_MODELS_NEGOTIATION_EXPERIMENT/)
      expect(code, abs).not.toMatch(/runModelsCatalogNegotiationExperiment/)
      expect(code, abs).not.toMatch(/modelsCatalogNegotiationExperiment/)
    }
  })

  it('TEST 15b: experiment helper file no longer exists', () => {
    const p = path.resolve(ROOT, 'src/main/openai/chatgpt/models/modelsCatalogNegotiationExperiment.ts')
    expect(fs.existsSync(p)).toBe(false)
  })

  it('obsolete files removed: modelCatalogVersion.ts + shared/utils/semver.ts', () => {
    expect(fs.existsSync(path.resolve(ROOT, 'src/main/openai/chatgpt/models/modelCatalogVersion.ts'))).toBe(false)
    expect(fs.existsSync(path.resolve(ROOT, 'src/shared/utils/semver.ts'))).toBe(false)
  })
})
