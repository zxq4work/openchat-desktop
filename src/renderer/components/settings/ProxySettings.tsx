import React, { useState, useEffect, useRef } from 'react'
import type { ProxyConfig, ProxyProtocol } from '../../../shared/types/settings'
import { useModelStore } from '../../stores/modelStore'

const DEFAULT_CONFIG: ProxyConfig = {
  enabled: false,
  protocol: 'http',
  host: '127.0.0.1',
  port: '',
  username: '',
  password: '',
}

export function ProxySettings() {
  const [config, setConfig] = useState<ProxyConfig>(DEFAULT_CONFIG)
  const [loaded, setLoaded] = useState(false)
  const configRef = useRef<ProxyConfig>(config)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setModels = useModelStore((s) => s.setModels)

  useEffect(() => {
    window.openchat.settings.getProxy().then((c) => {
      if (c) {
        setConfig(c)
        configRef.current = c
      }
      setLoaded(true)
    })
  }, [])

  const doSave = (newConfig: ProxyConfig) => {
    window.openchat.settings.setProxy(newConfig)
    window.openchat.models.refresh().then(setModels).catch(() => {})
  }

  const update = (patch: Partial<ProxyConfig>) => {
    const newConfig = { ...configRef.current, ...patch }
    setConfig(newConfig)
    configRef.current = newConfig

    if (timerRef.current) clearTimeout(timerRef.current)

    if ('enabled' in patch) {
      doSave(newConfig)
    } else {
      timerRef.current = setTimeout(() => doSave(newConfig), 600)
    }
  }

  if (!loaded) return null

  return (
    <div className="proxy-settings">
      <label className="settings-switch-label">
        <span>启用代理</span>
        <div
          className={`settings-switch ${config.enabled ? 'settings-switch-on' : ''}`}
          onClick={() => update({ enabled: !config.enabled })}
          role="switch"
          aria-checked={config.enabled}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              update({ enabled: !config.enabled })
            }
          }}
        >
          <div className="settings-switch-thumb" />
        </div>
      </label>
      <p className="settings-switch-hint">开启后立即生效并自动保存</p>

      {config.enabled && (
        <div className="proxy-form">
          <div className="proxy-form-row">
            <div className="proxy-field">
              <label className="proxy-label">协议</label>
              <select
                className="proxy-select"
                value={config.protocol}
                onChange={(e) => update({ protocol: e.target.value as ProxyProtocol })}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="proxy-field proxy-field-host">
              <label className="proxy-label">主机</label>
              <input
                className="proxy-input"
                type="text"
                value={config.host}
                onChange={(e) => update({ host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </div>
            <div className="proxy-field proxy-field-port">
              <label className="proxy-label">端口</label>
              <input
                className="proxy-input"
                type="text"
                value={config.port}
                onChange={(e) => update({ port: e.target.value })}
                placeholder="1087"
              />
            </div>
          </div>
          <div className="proxy-form-row">
            <div className="proxy-field">
              <label className="proxy-label">用户名</label>
              <input
                className="proxy-input"
                type="text"
                value={config.username}
                onChange={(e) => update({ username: e.target.value })}
                placeholder="（可选）"
              />
            </div>
            <div className="proxy-field">
              <label className="proxy-label">密码</label>
              <input
                className="proxy-input"
                type="password"
                value={config.password}
                onChange={(e) => update({ password: e.target.value })}
                placeholder="（可选）"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}