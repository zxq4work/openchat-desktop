// 极轻量 Boot Preference：仅保存启动首帧需要的主题信息。
// 使用独立 JSON 文件，不依赖 sql.js / SettingsRepository，可同步读取。
// 这样 BrowserWindow 创建前就能拿到主题，首帧背景色与 Splash 一致。
import * as fs from 'fs'
import * as path from 'path'
import { app, nativeTheme } from 'electron'
import { SPLASH_BG_LIGHT, SPLASH_BG_DARK } from '../../shared/constants'

export type BootTheme = 'light' | 'dark' | 'system'

interface BootPreferencesData {
  theme?: BootTheme
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'boot-preferences.json')
}

function resolveTheme(theme: BootTheme): 'light' | 'dark' {
  if (theme === 'light') return 'light'
  if (theme === 'dark') return 'dark'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function readBootTheme(): 'light' | 'dark' {
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8')
    const data = JSON.parse(raw) as BootPreferencesData
    if (data.theme) {
      return resolveTheme(data.theme)
    }
  } catch {
    // 文件不存在或损坏，fallback
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function getBootBackgroundColor(): string {
  return readBootTheme() === 'dark' ? SPLASH_BG_DARK : SPLASH_BG_LIGHT
}

export function writeBootTheme(theme: BootTheme): void {
  try {
    const dir = path.dirname(getFilePath())
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const data: BootPreferencesData = { theme }
    const tmp = getFilePath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8')
    fs.renameSync(tmp, getFilePath())
  } catch (err) {
    console.error('Failed to write boot preferences:', err)
  }
}