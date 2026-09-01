import React, { useEffect, useState, useRef } from 'react'
import { Dropdown } from '../Dropdown'

const ENGINE_OPTIONS = [
  { value: 'bing', label: 'Bing' },
  { value: 'baidu', label: '百度' },
  { value: 'google', label: 'Google' },
]

export function WebSearchEngineSettings() {
  const [engine, setEngine] = useState<string>('bing')
  const [loaded, setLoaded] = useState(false)
  const engineRef = useRef(engine)

  useEffect(() => {
    window.openchat.settings.getWebSearchEngine().then((e) => {
      if (e) {
        setEngine(e)
        engineRef.current = e
      }
    }).catch((err) => {
      console.error('[WebSearchEngineSettings] load failed:', err)
    }).finally(() => {
      setLoaded(true)
    })
  }, [])

  const handleChange = (value: string) => {
    setEngine(value)
    engineRef.current = value
    window.openchat.settings.setWebSearchEngine(value)
  }

  const handleOpenGoogleSession = () => {
    window.openchat.googleSearch.openSession()
  }

  if (!loaded) return null

  return (
    <div>
      <div className="default-model-row">
        <label className="default-model-label">搜索引擎</label>
        <Dropdown
          className="default-model-dropdown"
          value={engine}
          placeholder="选择搜索引擎"
          options={ENGINE_OPTIONS}
          onChange={handleChange}
          ariaLabel="选择搜索引擎"
        />
      </div>
      <p className="default-model-hint">
        此搜索引擎仅用于自定义 API 提供商。ChatGPT / Codex 使用其官方搜索能力。
      </p>
      {engine === 'google' && (
        <div className="proxy-system-info" style={{ marginTop: 8 }}>
          <p className="proxy-system-hint">
            Google 使用内置 Chromium 加载搜索页面，需要 JavaScript 执行。首次使用可能需要完成 Google 验证。
          </p>
          <button
            className="proxy-system-test-btn"
            onClick={handleOpenGoogleSession}
          >
            打开 Google 搜索会话
          </button>
        </div>
      )}
    </div>
  )
}