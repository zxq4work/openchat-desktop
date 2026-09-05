// 打包前检查：electron-builder 需要 node-linker=hoisted 才能正确解析间接依赖
// （如 https-proxy-agent -> debug）。
//
// pnpm ≥10 内置版本管理，会自动根据 packageManager 字段匹配版本，
// 如果此检查被触发，说明版本管理未生效或被禁用。
const { readFileSync } = require('fs')
const { join } = require('path')

const agent = process.env.npm_config_user_agent || ''
if (!agent.includes('pnpm/')) return

const m = agent.match(/pnpm\/(\d+)/)
if (!m) return

const major = +m[1]

let pkg
try {
  pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
} catch {
  console.error('无法读取 package.json，无法校验 pnpm 版本。')
  process.exit(1)
}

const declared = pkg.packageManager || 'pnpm@10'

if (!declared.startsWith('pnpm@')) {
  console.error('packageManager 字段不是 pnpm，找到：%s', declared)
  console.error('本项目需要使用 pnpm@10')
  process.exit(1)
}

// 版本正确，放行
if (major === 10) return

// --- 版本不匹配 ---
console.error('当前 pnpm 主版本为 %d，项目需要 %s。', major, declared)

if (major < 10) {
  console.error('pnpm <10 没有内置版本管理，无法自动匹配 packageManager 声明的版本。')
  console.error('')
  console.error('请启用 corepack：')
  console.error('  corepack enable')
  console.error('  pnpm install')
} else {
  console.error('pnpm ≥10 内置版本管理会自动匹配 packageManager 声明的版本，')
  console.error('但你当前运行的版本仍是 %d，说明版本管理未生效或被禁用。', major)
  console.error('')
  console.error('请手动安装匹配的版本：')
  console.error('  pnpm self-update %s', declared.replace('pnpm@', ''))
  console.error('')
  console.error('当前 pnpm 配置（可用于排查）：')
  console.error('  pnpm config list')
}

console.error('')
console.error('或者改用 npm：')
console.error('  rm -rf node_modules && npm install')
process.exit(1)