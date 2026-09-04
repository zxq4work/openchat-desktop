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
  const [maxResults, setMaxResults] = useState(10)
  const [maxToolRounds, setMaxToolRounds] = useState(3)
  const engineRef = useRef(engine)
  const maxResultsRef = useRef(maxResults)
  const maxToolRoundsRef = useRef(maxToolRounds)

  useEffect(() => {
    Promise.all([
      window.openchat.settings.getWebSearchEngine(),
      window.openchat.settings.getWebSearchConfig(),
    ]).then(([e, config]) => {
      if (e) {
        setEngine(e)
        engineRef.current = e
      }
      if (config) {
        setMaxResults(config.maxResults)
        setMaxToolRounds(config.maxToolRounds)
        maxResultsRef.current = config.maxResults
        maxToolRoundsRef.current = config.maxToolRounds
      }
    }).catch((err) => {
      console.error('[WebSearchEngineSettings] load failed:', err)
    }).finally(() => {
      setLoaded(true)
    })
  }, [])

  const handleEngineChange = (value: string) => {
    setEngine(value)
    engineRef.current = value
    window.openchat.settings.setWebSearchEngine(value)
  }

  const handleMaxResultsChange = (value: number) => {
    setMaxResults(value)
    maxResultsRef.current = value
    window.openchat.settings.setWebSearchConfig({ maxResults: value, maxToolRounds: maxToolRoundsRef.current })
  }

  const handleMaxToolRoundsChange = (value: number) => {
    setMaxToolRounds(value)
    maxToolRoundsRef.current = value
    window.openchat.settings.setWebSearchConfig({ maxResults: maxResultsRef.current, maxToolRounds: value })
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
          onChange={handleEngineChange}
          ariaLabel="选择搜索引擎"
        />
      </div>
      <div className="default-model-row">
        <label className="default-model-label">搜索结果数量</label>
        <div className="search-config-slider-row">
          <input
            type="range"
            className="search-config-slider"
            min={3}
            max={20}
            value={maxResults}
            onChange={(e) => handleMaxResultsChange(Number(e.target.value))}
          />
          <span className="search-config-slider-value">{maxResults}</span>
        </div>
      </div>
      <div className="default-model-row">
        <label className="default-model-label">搜索轮数上限</label>
        <div className="search-config-slider-row">
          <input
            type="range"
            className="search-config-slider"
            min={2}
            max={10}
            value={maxToolRounds}
            onChange={(e) => handleMaxToolRoundsChange(Number(e.target.value))}
          />
          <span className="search-config-slider-value">{maxToolRounds}</span>
        </div>
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