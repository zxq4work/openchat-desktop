// 用系统默认浏览器搜索文本。沿用项目既有实现：按设置项选择搜索引擎，
// 经 preload 的 openExternal 交给系统浏览器打开。集中一处，供消息菜单与列表复用。
export async function searchInBrowser(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  const query = encodeURIComponent(trimmed)
  const engine = await window.openchat.settings.getWebSearchEngine()
  let url: string
  switch (engine) {
    case 'baidu':
      url = `https://www.baidu.com/s?wd=${query}`
      break
    case 'google':
      url = `https://www.google.com/search?q=${query}`
      break
    default:
      url = `https://www.bing.com/search?q=${query}`
  }
  window.openchat.openExternal(url)
}
