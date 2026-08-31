import React, { useState, useEffect, useRef } from 'react'
import type { ProxyConfig, ProxyMode } from '../../../shared/types/settings'
import { useModelStore } from '../../stores/modelStore'
import { Dropdown } from '../Dropdown'

const DEFAULT_CONFIG: ProxyConfig = {
  enabled: false,
  protocol: 'http',
  host: '127.0.0.1',
  port: '',
  username: '',
  password: '',
  mode: 'direct',
}

const MODE_OPTIONS = [
  { value: 'direct', label: '不使用代理' },
  { value: 'system', label: '系统代理' },
  { value: 'http', label: 'HTTP' },
  { value: 'socks5', label: 'SOCKS5' },
]

const PROTOCOL_OPTIONS = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
]

const TEST_URLS = [
  'https://www.baidu.com/',
  'https://www.google.com/',
  'https://chatgpt.com/',
]

function getMode(config: ProxyConfig): ProxyMode {
  return config.mode || (config.enabled ? (config.protocol === 'socks5' ? 'socks5' : 'http') : 'direct')
}

function toConfig(mode: ProxyMode, prev: ProxyConfig): ProxyConfig {
  switch (mode) {
    case 'system':
      return { ...prev, enabled: true, mode: 'system' }
    case 'direct':
      return { ...prev, enabled: false, mode: 'direct' }
    case 'http':
      return { ...prev, enabled: true, mode: 'http', protocol: 'http' }
    case 'socks5':
      return { ...prev, enabled: true, mode: 'socks5', protocol: 'socks5' }
    default:
      return prev
  }
}

export function ProxySettings() {
  const [config, setConfig] = useState<ProxyConfig>(DEFAULT_CONFIG)
  const [loaded, setLoaded] = useState(false)
  const [testResults, setTestResults] = useState<Array<{ url: string; route: string }> | null>(null)
  const [testRunning, setTestRunning] = useState(false)
  const configRef = useRef<ProxyConfig>(config)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setModels = useModelStore((s) => s.setModels)

  useEffect(() => {
    window.openchat.settings.getProxy().then((c) => {
      if (c) {
        // 迁移旧配置：无 mode 字段时根据 enabled/protocol 推断
        const withMode = { ...c, mode: c.mode || (c.enabled ? (c.protocol === 'socks5' ? 'socks5' as const : 'http' as const) : 'direct' as const) }
        setConfig(withMode)
        configRef.current = withMode
      }
    }).catch((err) => {
      console.error('[ProxySettings] load failed:', err)
    }).finally(() => {
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

    if ('mode' in patch) {
      doSave(newConfig)
    } else {
      timerRef.current = setTimeout(() => doSave(newConfig), 600)
    }
  }

  const handleModeChange = (value: string) => {
    const mode = value as ProxyMode
    const newConfig = toConfig(mode, configRef.current)
    setConfig(newConfig)
    configRef.current = newConfig
    doSave(newConfig)
    setTestResults(null)
  }

  const handleTestSystemProxy = async () => {
    setTestRunning(true)
    setTestResults(null)
    const results: Array<{ url: string; route: string }> = []
    for (const url of TEST_URLS) {
      try {
        const route = await window.openchat.settings.resolveSystemProxy(url)
        results.push({ url, route })
      } catch {
        results.push({ url, route: 'ERROR' })
      }
    }
    setTestResults(results)
    setTestRunning(false)
  }

  if (!loaded) return null

  const mode = getMode(config)
  const showFixedProxy = mode === 'http' || mode === 'socks5'

  return (
    <div className="proxy-settings">
      <div className="default-model-row">
        <label className="default-model-label">代理方式</label>
        <Dropdown
          className="default-model-dropdown"
          value={mode}
          placeholder="选择代理方式"
          options={MODE_OPTIONS}
          onChange={handleModeChange}
          ariaLabel="选择代理方式"
        />
      </div>

      {mode === 'system' && (
        <div className="proxy-system-info">
          <p className="proxy-system-hint">
            跟随操作系统代理设置，自动支持系统代理、PAC 和自动分流。
          </p>
          <button
            className="proxy-system-test-btn"
            onClick={handleTestSystemProxy}
            disabled={testRunning}
          >
            {testRunning ? '正在测试...' : '测试系统代理'}
          </button>
          {testResults && (
            <div className="proxy-system-test-results">
              {testResults.map((r) => (
                <div key={r.url} className="proxy-system-test-row">
                  <span className="proxy-system-test-url">{r.url}</span>
                  <span className="proxy-system-test-route">{r.route}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'direct' && (
        <p className="proxy-system-hint">所有请求直连，不使用代理。</p>
      )}

      {showFixedProxy && (
        <div className="proxy-form">
          <div className="proxy-form-row">
            <div className="proxy-field">
              <label className="proxy-label">协议</label>
              <Dropdown
                className="proxy-protocol-dropdown"
                value={config.protocol}
                options={PROTOCOL_OPTIONS}
                onChange={(v) => update({ protocol: v as ProxyConfig['protocol'] })}
                ariaLabel="选择代理协议"
              />
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