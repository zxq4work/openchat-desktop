#!/usr/bin/env node
/**
 * OpenChat Desktop — 一键开发启动脚本
 * 编译主进程 TS → 启动 Vite → 启动 Electron
 * 用法: node scripts/dev.mjs
 */

import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function log(label, text) {
  console.log(`\x1b[36m[${label}]\x1b[0m ${text}`)
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://localhost:${port}`)
      return true
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function runVite() {
  const vite = spawn('npx', ['vite', '--port', '5173'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env },
  })
  vite.stdout.on('data', (d) => process.stdout.write(d))
  vite.stderr.on('data', (d) => process.stderr.write(d))
  vite.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.exit(code)
    }
  })
  return vite
}

function runElectron() {
  const electron = spawn('npx', ['electron', '.'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173' },
  })
  electron.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

async function main() {
  log('dev', '编译主进程 TypeScript...')
  await new Promise((resolve, reject) => {
    const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.main.json'], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    })
    tsc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tsc exited with code ${code}`))
    })
  })
  log('dev', '主进程编译完成')

  log('dev', '启动 Vite 开发服务器...')
  const vite = runVite()

  log('dev', '等待 Vite 就绪 (http://localhost:5173)...')
  const ready = await waitForPort(5173)
  if (!ready) {
    log('dev', 'Vite 启动超时，退出')
    vite.kill()
    process.exit(1)
  }

  log('dev', '启动 Electron...')
  runElectron()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})