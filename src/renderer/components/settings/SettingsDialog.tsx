import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { AccountPanel } from './AccountPanel'
import { CODEX_VERSION } from '../../../shared/constants'

export function SettingsDialog() {
  const setSettingsDialogOpen = useUiStore((s) => s.setSettingsDialogOpen)

  return (
    <div className="dialog-overlay">
      <div className="dialog settings-dialog">
        <h3>设置</h3>

        <div className="settings-section">
          <h4>账户</h4>
          <AccountPanel />
        </div>

        <div className="settings-section">
          <h4>关于</h4>
          <div className="about-info">
            <div>OpenChat Desktop 0.1.0</div>
            <div>Electron 22.3.27</div>
            <div>Codex App Server {CODEX_VERSION}</div>
            <div>Protocol {CODEX_VERSION}</div>
          </div>
        </div>

        <div className="dialog-actions">
          <button className="btn-cancel" onClick={() => setSettingsDialogOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  )
}