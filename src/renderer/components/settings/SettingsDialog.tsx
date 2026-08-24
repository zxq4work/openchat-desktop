import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useThemeStore, type ThemeMode } from '../../stores/themeStore'
import { AccountPanel } from './AccountPanel'
import { ProxySettings } from './ProxySettings'
import { ProviderSettings } from './ProviderSettings'
const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
  { mode: 'system', label: '跟随系统' },
]

export function SettingsDialog() {
  const setSettingsDialogOpen = useUiStore((s) => s.setSettingsDialogOpen)
  const themeMode = useThemeStore((s) => s.mode)
  const setThemeMode = useThemeStore((s) => s.setMode)

  return (
    <div className="dialog-overlay">
      <div className="dialog settings-dialog">
        <div className="settings-dialog-header">
          <h3>设置</h3>
          <button
            className="settings-dialog-close-btn"
            onClick={() => setSettingsDialogOpen(false)}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="settings-dialog-body">
          <div className="settings-section">
            <h4>账户</h4>
            <AccountPanel />
          </div>

          <div className="settings-section-divider" />

          <div className="settings-section">
            <h4>主题</h4>
            <div className="theme-setting">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.mode}
                  className={`theme-option${themeMode === opt.mode ? ' active' : ''}`}
                  onClick={() => setThemeMode(opt.mode)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section-divider" />

          <div className="settings-section">
            <h4>代理</h4>
            <ProxySettings />
          </div>

          <div className="settings-section-divider" />

          <div className="settings-section">
            <ProviderSettings />
          </div>

          <div className="settings-section-divider" />

          <div className="settings-section">
            <h4>关于</h4>
            <div className="about-info">
              <div>OpenChat Desktop 0.1.0</div>
              <div>Electron 22.3.27</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}