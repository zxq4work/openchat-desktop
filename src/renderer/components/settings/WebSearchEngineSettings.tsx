import React, { useEffect, useState, useRef } from 'react'
import { Dropdown } from '../Dropdown'

const ENGINE_OPTIONS = [
  { value: 'bing', label: 'Bing' },
  { value: 'baidu', label: '百度' },
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
      setLoaded(true)
    })
  }, [])

  const handleChange = (value: string) => {
    setEngine(value)
    engineRef.current = value
    window.openchat.settings.setWebSearchEngine(value)
  }

  if (!loaded) return null

  return (
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
  )
}