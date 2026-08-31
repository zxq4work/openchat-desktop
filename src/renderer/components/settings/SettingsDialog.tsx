import React from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useThemeStore, type ThemeMode } from '../../stores/themeStore'
import { AccountPanel } from './AccountPanel'
import { ProxySettings } from './ProxySettings'
import { ProviderSettings } from './ProviderSettings'
import { DefaultModelSettings } from './DefaultModelSettings'
import { WebSearchEngineSettings } from './WebSearchEngineSettings'
const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
  { mode: 'system', label: '跟随系统' },
]

export function SettingsDialog() {
  const setSettingsDialogOpen = useUiStore((s) => s.setSettingsDialogOpen)
  const themeMode = useThemeStore((s) => s.mode)
  const setThemeMode = useThemeStore((s) => s.setMode)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)

  const handleClearAll = async () => {
    setClearing(true)
    try {
      await window.openchat.conversations.removeAll()
      useConversationStore.getState().clearAll()
      setConfirmOpen(false)
      setSettingsDialogOpen(false)
      useUiStore.getState().showToast('所有会话已清空')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="dialog-overlay">
      <div className={`dialog settings-dialog${confirmOpen ? ' has-confirm' : ''}`}>
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
            <h4>默认模型</h4>
            <DefaultModelSettings />
          </div>

          <div className="settings-section-divider" />

          <div className="settings-section">
            <h4>网页搜索</h4>
            <WebSearchEngineSettings />
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
            <h4>数据管理</h4>
            <button className="btn-logout-outline" onClick={() => setConfirmOpen(true)}>
              清空所有会话
            </button>
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

      {confirmOpen && (
        <div className="confirm-layer">
          <div className="dialog confirm-dialog">
            <h3>清空所有会话</h3>
            <p className="dialog-subtitle">
              此操作不可撤销，所有聊天记录将永久删除。
            </p>
            <div className="dialog-actions">
              <button
                className="btn-cancel"
                onClick={() => setConfirmOpen(false)}
                disabled={clearing}
              >
                取消
              </button>
              <button
                className="btn-logout"
                onClick={handleClearAll}
                disabled={clearing}
              >
                {clearing ? (
                  <>
                    <span className="btn-spinner" />
                    删除中...
                  </>
                ) : (
                  '确认清空'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}