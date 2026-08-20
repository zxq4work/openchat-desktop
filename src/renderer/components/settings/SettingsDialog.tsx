import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { AccountPanel } from './AccountPanel'
import { ProxySettings } from './ProxySettings'
import { CODEX_VERSION } from '../../../shared/constants'

export function SettingsDialog() {
  const setSettingsDialogOpen = useUiStore((s) => s.setSettingsDialogOpen)

  const handleOverlayMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setSettingsDialogOpen(false)
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={handleOverlayMouseDown}>
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

        <div className="settings-section">
          <h4>账户</h4>
          <AccountPanel />
        </div>

        <div className="settings-section-divider" />

        <div className="settings-section">
          <h4>代理</h4>
          <ProxySettings />
        </div>

        <div className="settings-section-divider" />

        <div className="settings-section">
          <h4>关于</h4>
          <div className="about-info">
            <div>OpenChat Desktop 0.1.0</div>
            <div>Electron 22.3.27</div>
            <div>Codex App Server {CODEX_VERSION}</div>
            <div>Protocol {CODEX_VERSION}</div>
          </div>
        </div>
      </div>
    </div>
  )
}