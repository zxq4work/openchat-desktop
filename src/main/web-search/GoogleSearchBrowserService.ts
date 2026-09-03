import { BrowserWindow, session as electronSession } from 'electron'
import type { Session } from 'electron'
import type { SearchResultItem } from '../../shared/types/provider'
import { getProxyMode, getProxyConfig } from '../openai/chatgpt/httpsClient'
import type { ProxyMode } from '../../shared/types/settings'

const GOOGLE_SEARCH_URL = 'https://www.google.com/search'
const GOOGLE_SESSION_PARTITION = 'persist:openchat-google-search'
const MAX_RESULTS = 10
const POLL_INTERVAL_MS = 250
const SEARCH_TIMEOUT_MS = 15000
const IDLE_DESTROY_MS = 60000

type GooglePageState = 'loading' | 'results' | 'consent' | 'challenge' | 'unavailable'

interface PageState {
  url: string
  title: string
  h3Count: number
  bodyText: string
}

/**
 * 管理 Google 搜索专用的隐藏 BrowserWindow。
 * 因为 Google 要求 JavaScript 执行（/httpservice/retry/enablejs），
 * 纯 HTTP HTML 抓取已不可用，必须使用真实 Chromium 渲染。
 */
export class GoogleSearchBrowserService {
  private window: BrowserWindow | null = null
  private searchSession: Session | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private currentSearch: Promise<SearchResultItem[]> | null = null
  private lastProxyMode: ProxyMode | null = null
  private webRequestHooked = false

  /** 确保 BrowserWindow 已创建并准备好 */
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      this.resetIdleTimer()
      return this.window
    }

    console.log('[GoogleBrowser] event=create')

    this.searchSession = electronSession.fromPartition(GOOGLE_SESSION_PARTITION, { cache: true })

    // 阻止图片、字体、媒体等重资源加载，降低 Google 搜索结果页的内存占用，
    // 避免主进程因 BrowserWindow 渲染 Google 页面而 OOM 崩溃。
    // 注意：不拦截 stylesheet，否则 CSS 隐藏的元素会变成可见，污染 innerText 提取结果。
    if (!this.webRequestHooked) {
      this.webRequestHooked = true
      this.searchSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const blocked = ['image', 'font', 'media']
        callback({ cancel: blocked.includes(details.resourceType) })
      })
    }

    // 同步当前代理设置
    await this.syncProxyToSession()

    this.window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        backgroundThrottling: false,
        partition: GOOGLE_SESSION_PARTITION,
      },
    })

    this.window.on('close', () => {
      console.log('[GoogleBrowser] event=window-closed')
    })

    this.resetIdleTimer()
    return this.window
  }

  /** 将当前代理设置同步到 Google 搜索 Session */
  async syncProxyToSession(): Promise<void> {
    const mode = getProxyMode()
    if (mode === this.lastProxyMode) return
    this.lastProxyMode = mode

    // 如果 session 还没创建，先创建再应用
    const ses = this.searchSession || electronSession.fromPartition(GOOGLE_SESSION_PARTITION, { cache: true })
    this.searchSession = ses

    switch (mode) {
      case 'system':
        console.log('[GoogleBrowser] proxy mode=system')
        await ses.setProxy({ mode: 'system' })
        break
      case 'direct':
        console.log('[GoogleBrowser] proxy mode=direct')
        await ses.setProxy({ mode: 'direct' })
        break
      case 'http':
      case 'socks5': {
        // 固定代理：使用 Chromium fixed_servers
        const config = getProxyConfig()
        if (config && config.host && config.port) {
          // Chromium proxyRules 格式：http 用 host:port，socks5 用 socks5://host:port
          const proxyRules =
            config.protocol === 'socks5'
              ? `socks5://${config.host}:${config.port}`
              : `${config.host}:${config.port}`
          console.log('[GoogleBrowser] proxy mode=%s proxyRules=%s', mode, proxyRules)
          await ses.setProxy({ mode: 'fixed_servers', proxyRules })
        } else {
          console.log('[GoogleBrowser] proxy mode=%s but no config, fallback to direct', mode)
          await ses.setProxy({ mode: 'direct' })
        }
        break
      }
    }
  }

  /** 在页面中提取搜索结果 */
  private static EXTRACT_SCRIPT = `
    (() => {
      const results = [];
      const seen = new Set();
      const headings = Array.from(document.querySelectorAll('h3'));
      const MAX = 10;

      for (const h3 of headings) {
        if (results.length >= MAX) break;

        let anchor = h3.closest('a[href]');
        if (!anchor) {
          let parent = h3.parentElement;
          for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
            const candidate = parent.querySelector('a[href]');
            if (candidate) { anchor = candidate; break; }
          }
        }
        if (!anchor) continue;

        let url = anchor.href;
        if (!url || url.startsWith('javascript:')) continue;

        // 解析 Google redirect
        try {
          const u = new URL(url);
          if (u.hostname === 'www.google.com' || u.hostname === 'google.com') {
            if (u.pathname === '/url') {
              const q = u.searchParams.get('q') || u.searchParams.get('url');
              if (q && (q.startsWith('http://') || q.startsWith('https://'))) {
                url = q;
              } else {
                continue;
              }
            } else if (
              u.pathname === '/search' ||
              u.pathname === '/preferences' ||
              u.pathname === '/advanced_search' ||
              u.pathname.startsWith('/search') ||
              u.pathname.startsWith('/setprefs')
            ) {
              continue;
            }
          }
        } catch { continue; }

        // 排除 Google 内部链接
        if (url.startsWith('https://accounts.google.com/') ||
            url.startsWith('https://support.google.com/') ||
            url.startsWith('https://policies.google.com/') ||
            url.startsWith('https://consent.google.com/')) {
          continue;
        }

        const title = h3.innerText.replace(/\\s+/g, ' ').trim();
        if (!title) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        // snippet
        let snippet = '';
        let container = h3.closest('.MjjYud') || h3.closest('.tF2Cxc') || h3.closest('.g');
        if (!container) {
          let p = h3.parentElement;
          for (let i = 0; p && i < 5; i++, p = p.parentElement) {
            container = p;
          }
        }
        if (container) {
          const snipEl =
            container.querySelector('.VwiC3b') ||
            container.querySelector('[data-sncf]') ||
            container.querySelector('.IsZvec') ||
            container.querySelector('.ITZIwc');
          if (snipEl) {
            snippet = snipEl.innerText.replace(/\\s+/g, ' ').trim();
          }
        }

        results.push({ title, url, snippet, index: results.length + 1 });
      }
      return results;
    })()
  `

  /** 轮询等待 Google SERP 渲染完成 */
  private async waitForResults(win: BrowserWindow, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const startTime = Date.now()
    let lastState: string | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    let abortHandler: (() => void) | null = null
    let consecutiveJsErrors = 0
    const MAX_CONSECUTIVE_JS_ERRORS = 5
    return new Promise<SearchResultItem[]>((resolve, reject) => {
      const cleanup = () => {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler)
          abortHandler = null
        }
      }

      // 监听页面加载失败，立即终止轮询。
      // ERR_ABORTED (-3) 是页面导航被替换/重定向时的正常信号（Google SERP 会追加 &sei= 参数做 JS 重定向），
      // 不能当成致命错误，否则会提前中断本次搜索并让 window 处于半加载状态。
      const failLoadHandler = (_event: Electron.Event, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
        console.log('[GoogleBrowser] did-fail-load errorCode=%d desc=%s url=%s isMainFrame=%s', errorCode, errorDescription, validatedURL, isMainFrame)
        if (errorCode === -3) {
          // ERR_ABORTED：导航被取消/替换，忽略，继续轮询
          return
        }
        settleWithCleanup(() => reject(new Error(`SEARCH_PAGE_LOAD_FAILED: 页面加载失败 (${errorCode} ${errorDescription})`)))
      }
      win.webContents.on('did-fail-load', failLoadHandler)

      // 监听 renderer 崩溃，避免 executeJavaScript 在已崩溃的进程上继续执行
      const crashedHandler = (_event: Electron.Event, details: { reason?: string; exitCode?: number }) => {
        console.log('[GoogleBrowser] render-process-gone reason=%s exitCode=%s', details?.reason ?? 'unknown', details?.exitCode ?? 'unknown')
        // 销毁窗口，让下一次搜索重新创建
        if (this.window && !this.window.isDestroyed()) {
          this.window.destroy()
        }
        this.window = null
        settleWithCleanup(() => reject(new Error('SEARCH_RENDERER_CRASHED: 搜索页面渲染进程崩溃')))
      }
      win.webContents.on('render-process-gone', crashedHandler)

      // 扩展 cleanup 以移除事件监听器
      const origCleanup = cleanup
      const fullCleanup = () => {
        origCleanup()
        win.webContents.removeListener('did-fail-load', failLoadHandler)
        win.webContents.removeListener('render-process-gone', crashedHandler)
      }

      const settleWithCleanup = (fn: () => void) => {
        if (settled) return
        settled = true
        fullCleanup()
        fn()
      }

      if (signal) {
        if (signal.aborted) {
          reject(new Error('Aborted'))
          return
        }
        abortHandler = () => {
          settleWithCleanup(() => {
            win.webContents.stop()
            reject(new Error('Aborted'))
          })
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      const poll = async () => {
        if (settled) return
        if (win.isDestroyed()) {
          settleWithCleanup(() => reject(new Error('SEARCH_WINDOW_DESTROYED: 搜索窗口已销毁')))
          return
        }

        try {
          const state = await win.webContents.executeJavaScript(`
            JSON.stringify({
              url: location.href,
              title: document.title,
              h3Count: document.querySelectorAll('h3').length,
              bodyText: (document.body?.innerText || '').slice(0, 1000)
            })
          `) as string

          if (settled) return
          consecutiveJsErrors = 0

          const pageState: PageState = JSON.parse(state)

          // 日志导航变化
          if (pageState.url !== lastState) {
            lastState = pageState.url
            console.log('[GoogleBrowser] navigation=%s', pageState.url)
          }

          const pageType = this.classifyPageState(pageState)
          const elapsed = Date.now() - startTime

          if (pageType === 'results') {
            // 提取结果
            const results = await win.webContents.executeJavaScript(
              GoogleSearchBrowserService.EXTRACT_SCRIPT
            ) as SearchResultItem[]

            if (settled) return

            console.log(
              '[GoogleBrowser] state=results h3Count=%d parsedResults=%d elapsed=%dms',
              pageState.h3Count,
              results.length,
              elapsed
            )

            if (results.length > 0) {
              settleWithCleanup(() => resolve(results))
              return
            }
          }

          if (settled) return

          if (pageType === 'challenge') {
            console.log('[GoogleBrowser] state=challenge elapsed=%dms', elapsed)
            settleWithCleanup(() => reject(new Error('SEARCH_PROVIDER_CHALLENGE: Google 要求验证当前网络请求，请更换网络/代理出口或切换其他搜索引擎。')))
            return
          }

          if (pageType === 'consent') {
            console.log('[GoogleBrowser] state=consent elapsed=%dms', elapsed)
            settleWithCleanup(() => reject(new Error('SEARCH_PROVIDER_CONSENT_REQUIRED: Google 需要同意隐私条款，请在设置中打开 Google 搜索会话完成同意。')))
            return
          }

          if (elapsed >= SEARCH_TIMEOUT_MS) {
            console.log('[GoogleBrowser] state=timeout pageType=%s url=%s', pageType, pageState.url)
            const timeoutErr =
              pageType === 'loading'
                ? new Error('SEARCH_JAVASCRIPT_FLOW_FAILED: Google 搜索 JavaScript 流程未在超时内完成')
                : new Error('SEARCH_TIMEOUT: Google search timed out')
            settleWithCleanup(() => reject(timeoutErr))
            return
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('SEARCH_')) {
            settleWithCleanup(() => reject(err))
            return
          }
          // executeJavaScript 可能因页面导航而失败，但连续失败超过阈值则终止
          consecutiveJsErrors++
          if (consecutiveJsErrors >= MAX_CONSECUTIVE_JS_ERRORS) {
            console.log('[GoogleBrowser] too many JS errors, stopping poll')
            settleWithCleanup(() => reject(new Error('SEARCH_JS_ERROR: 搜索页面脚本执行持续失败')))
            return
          }
        }

        // 串行化下一次轮询（等待上一次完成后再调度），避免重叠
        if (!settled) {
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      }

      // 启动第一次轮询
      pollTimer = setTimeout(poll, 0)
    })
  }

  private classifyPageState(state: PageState): GooglePageState {
    const bodyLower = state.bodyText.toLowerCase()
    const urlLower = state.url.toLowerCase()

    // Challenge: /sorry/ 或 unusual traffic
    if (urlLower.includes('/sorry/')) return 'challenge'
    if (
      bodyLower.includes('unusual traffic') ||
      bodyLower.includes('not a robot') ||
      bodyLower.includes('recaptcha') ||
      bodyLower.includes('verify you\'re not a robot') ||
      bodyLower.includes('verifying your request')
    ) {
      return 'challenge'
    }

    // Consent
    if (urlLower.includes('consent.google.com')) return 'consent'
    if (
      bodyLower.includes('before you continue to google') &&
      (bodyLower.includes('consent') || bodyLower.includes('privacy') || bodyLower.includes('cookie'))
    ) {
      return 'consent'
    }

    // Results: has h3 headings
    if (state.h3Count > 0) return 'results'

    // Loading: enablejs 或其他中间页面
    if (
      urlLower.includes('enablejs') ||
      urlLower.includes('/httpservice/') ||
      urlLower.includes('retry')
    ) {
      return 'loading'
    }

    return 'unavailable'
  }

  /** 执行搜索 */
  async search(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    // 串行化：同一时间只能有一个搜索
    const prev = this.currentSearch
    if (prev) {
      try { await prev } catch { /* ignore */ }
    }

    const promise = this.doSearch(query, signal)
    this.currentSearch = promise
    try {
      return await promise
    } finally {
      if (this.currentSearch === promise) {
        this.currentSearch = null
      }
    }
  }

  private async doSearch(query: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
    const win = await this.ensureWindow()

    // 同步代理（代理设置可能已变更）
    await this.syncProxyToSession()

    const url = new URL(GOOGLE_SEARCH_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('hl', 'zh-CN')
    const urlStr = url.toString()

    console.log('[GoogleBrowser] query=%s url=%s', query, urlStr)

    // 停止当前页面加载（如果有残留）
    win.webContents.stop()

    // 加载搜索 URL
    // Google 搜索结果页加载后会做一次 JS 重定向（追加 &sei= 会话参数），
    // 首次导航因此被 abort，loadURL 的 Promise 会以 ERR_ABORTED(-3) reject。
    // 这是正常现象：捕获并忽略，继续轮询等待重定向后的最终页面渲染完成。
    // 若此处把 rejection 当致命错误抛出，会让 window 停留在半加载状态，
    // 下一次搜索复用该 window 时 loadURL 触发 Chromium SIGSEGV。
    try {
      await win.loadURL(urlStr)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log('[GoogleBrowser] loadURL rejected (non-fatal) msg=%s', msg)
    }

    // 等待结果
    return this.waitForResults(win, signal)
  }

  // —— 用户交互 ——

  /** 打开 Google 搜索会话窗口（供用户手动完成 Consent/验证） */
  openSession(): void {
    if (!this.window || this.window.isDestroyed()) {
      // 还未创建过，先创建
      this.ensureWindow().then((win) => {
        win.show()
        win.loadURL('https://www.google.com/?hl=zh-CN')
      })
      return
    }

    this.window.show()
    if (this.window.webContents.getURL().startsWith('about:')) {
      this.window.loadURL('https://www.google.com/?hl=zh-CN')
    }
  }

  // —— 生命周期 ——

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      console.log('[GoogleBrowser] event=idle-destroy')
      this.destroyWindow()
    }, IDLE_DESTROY_MS)
  }

  private destroyWindow(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
    this.lastProxyMode = null
    console.log('[GoogleBrowser] event=destroyed')
  }
}

// 全局单例
export const googleSearchBrowser = new GoogleSearchBrowserService()