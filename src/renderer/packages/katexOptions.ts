/**
 * KaTeX rehype-katex 共享配置
 *
 * 两条 Markdown 路径（ReactMarkdown fallback + HAST compile）必须使用同一份配置，
 * 避免 streaming → settled 切换时 DOM 结构不一致。
 *
 * 实验flag ENABLE_KATEX_HTML_ONLY：
 *   true  → output: 'html'（移除 MathML 输出，减少约 25~30% KaTeX DOM 节点）
 *   false → KaTeX 默认输出（html + mathml）
 *
 * 已知 trade-off：HTML-only 模式删除 MathML 输出，降低屏幕阅读器/无障碍语义。
 * 实验结束后决定是否永久启用。
 */

export const ENABLE_KATEX_HTML_ONLY = true

export const KATEX_OPTIONS = {
  strict: 'ignore',
  throwOnError: false,
  ...(ENABLE_KATEX_HTML_ONLY ? { output: 'html' as const } : {}),
}
