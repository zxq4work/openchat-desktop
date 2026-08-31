// Splash 模板：Main Process 生成纯静态 HTML，零 JavaScript、零外部资源。
// 颜色复用主界面 Design Tokens（见 src/renderer/styles/global.css）。

const THEME = {
  light: {
    bgPrimary: '#F7F8FC',
    textPrimary: '#1F2937',
    textSecondary: '#6B7280',
    textMuted: '#9CA3AF',
    borderColor: '#E5E7EB',
    accent: '#4A90E2',
    accentShadow: 'rgba(74, 144, 226, 0.25)',
  },
  dark: {
    bgPrimary: '#0F172A',
    textPrimary: '#E5E7EB',
    textSecondary: '#94A3B8',
    textMuted: '#64748B',
    borderColor: '#243247',
    accent: '#60A5FA',
    accentShadow: 'rgba(96, 165, 250, 0.25)',
  },
} as const

export type SplashTheme = keyof typeof THEME

export function createSplashHtml(theme: SplashTheme, version = '0.1.0'): string {
  const t = THEME[theme]

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <title>OpenChat Desktop</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: ${t.bgPrimary};
      color: ${t.textPrimary};
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      user-select: none;
      -webkit-user-select: none;
    }
    .splash {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      padding: 32px;
      text-align: center;
      opacity: 0;
      animation: splashFadeIn 0.35s ease forwards;
    }
    @keyframes splashFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .splash-logo {
      width: 72px;
      height: 72px;
      border-radius: 20px;
      background: ${t.accent};
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      box-shadow: 0 8px 24px ${t.accentShadow};
    }
    .splash-logo-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #FFFFFF;
      animation: splashDot 1.2s ease-in-out infinite;
    }
    .splash-logo-dot:nth-child(2) { animation-delay: 0.18s; }
    .splash-logo-dot:nth-child(3) { animation-delay: 0.36s; }
    @keyframes splashDot {
      0%, 60%, 100% { opacity: 0.4; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-5px); }
    }
    .splash-title {
      font-size: 20px;
      font-weight: 600;
      color: ${t.textPrimary};
      letter-spacing: 0.2px;
    }
    .splash-subtitle {
      font-size: 13px;
      color: ${t.textSecondary};
      line-height: 1.5;
    }
    .splash-progress {
      width: 140px;
      height: 3px;
      border-radius: 2px;
      background: ${t.borderColor};
      overflow: hidden;
      margin-top: 6px;
    }
    .splash-progress-bar {
      width: 40%;
      height: 100%;
      border-radius: 2px;
      background: ${t.accent};
      animation: splashProgress 1.4s ease-in-out infinite;
    }
    @keyframes splashProgress {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(350%); }
    }
    .splash-version {
      font-size: 11px;
      color: ${t.textMuted};
      letter-spacing: 0.3px;
    }
  </style>
</head>
<body>
  <div class="splash">
    <div class="splash-logo">
      <div class="splash-logo-dot"></div>
      <div class="splash-logo-dot"></div>
      <div class="splash-logo-dot"></div>
    </div>
    <div class="splash-title">OpenChat Desktop</div>
    <div class="splash-subtitle">正在启动...</div>
    <div class="splash-progress"><div class="splash-progress-bar"></div></div>
    <div class="splash-version">v${version}</div>
  </div>
</body>
</html>`
}
