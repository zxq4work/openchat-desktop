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
        VITE_DEV_SERVER_URL:url
      }
    }
  )
  electron.on('exit',stop)

}


main().catch(async e=>{
  console.error(e)
  await stop()
})