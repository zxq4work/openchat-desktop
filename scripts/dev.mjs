#!/usr/bin/env node
/**
 * OpenChat Desktop — 一键开发启动脚本
 * 编译主进程 TS → 启动 Vite → 启动 Electron
 * 用法: node scripts/dev.mjs
 */

import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'vite'

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..'
)

let vite
let electron


const bin = name =>
  resolve(
    root,
    'node_modules/.bin',
    process.platform === 'win32'
      ? `${name}.cmd`
      : name
  )


const run = (cmd,args)=>
  new Promise((ok,fail)=>{
    const p = spawn(cmd,args,{
      cwd:root,
      stdio:'inherit',
      shell: process.platform === 'win32'
    })

    p.on('exit',c=>
      c===0 ? ok() : fail(c)
    )
  })


async function stop(){

  console.log('\n[dev] stopping...')

  electron?.kill('SIGTERM')

  await vite?.close()

  process.exit()

}


process.on('SIGINT',stop)
process.on('SIGTERM',stop)



async function main(){

  console.log('[dev] build main')

  await run(
    bin('tsc'),
    [
      '-p',
      'tsconfig.main.json'
    ]
  )


  console.log('[dev] start vite')

  vite = await createServer({
    configFile:
      resolve(root,'vite.config.ts'),

    server:{
      port:5173,
      strictPort:false
    }
  })


  await vite.listen()


  const url =
    vite.resolvedUrls.local[0]


  console.log(
    `[dev] vite ${url}`
  )


  console.log('[dev] start electron')


  electron = spawn(
    bin('electron'),
    ['.'],
    {
      cwd:root,
      stdio:'inherit',
      shell: process.platform === 'win32',
      env:{
        ...process.env,
        VITE_DEV_SERVER_URL:url,
        // 开发模式默认开启动态请求参数调试日志；用户显式设置该变量时不覆盖。
        // 纯 JS 写法，兼容 macOS / Windows，不依赖 shell 语法或 cross-env。
        // 仅作用于 dev 启动的 Electron（即 Main Process）；build / package / test 不受影响。
        OPENCHAT_DEBUG_REQUEST_PARAMS:
          process.env.OPENCHAT_DEBUG_REQUEST_PARAMS ?? '1'
      }
    }
  )
  electron.on('exit',stop)

}


main().catch(async e=>{
  console.error(e)
  await stop()
})