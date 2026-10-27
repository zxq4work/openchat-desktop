// 版本号唯一来源是 package.json：应用版本取 version，Electron 版本取 devDependencies.electron。
// 构建期由 vite.config.ts 通过 define 注入 __APP_VERSION__ / __ELECTRON_VERSION__，
// UI 统一引用这些常量，避免各处手写版本号造成不一致。
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

export const ELECTRON_VERSION: string =
  typeof __ELECTRON_VERSION__ !== 'undefined' ? __ELECTRON_VERSION__ : ''