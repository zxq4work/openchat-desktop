import React, { useMemo, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import rehypeKatex from 'rehype-katex'
import { processLaTeX } from '../packages/latex'
import { compileMarkdownToHast } from '../packages/markdownCompiler'
import { renderHastToReact } from '../packages/markdownHastRenderer'
import { hastCacheGet, hastCacheSet } from '../packages/markdownHastCache'
import { KATEX_OPTIONS } from '../packages/katexOptions'

// Feature flag: 关闭后 100% 恢复原始 ReactMarkdown 路径
const ENABLE_MARKDOWN_HAST_CACHE = true

interface MarkdownRendererProps {
  children: string
  // 可选：传入 message.id 用于缓存 key；不传则不走缓存
  messageId?: string
  // 可选：标记是否为 settled (completed/stopped/failed) 的 assistant 消息
  settled?: boolean
}

function extractTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractTextContent).join('')
  if (React.isValidElement(node)) {
    return extractTextContent((node.props as any).children)
  }
  return ''
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      document.execCommand('copy')
    }
  }, [code])

  return (
    <button className="code-copy-button" onClick={handleCopy} title={copied ? '已复制' : '复制代码'}>
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function CodeRenderer({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'>) {
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

function PreRenderer({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) {
  const codeElement = React.Children.only(children) as React.ReactElement
  const className = codeElement.props.className || ''
  const language = className.replace('language-', '')
  const codeText = extractTextContent(codeElement.props.children)

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-language">{language}</span>
        <CopyButton code={codeText} />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  )
}

function LinkRenderer({ href, children, ...props }: React.ComponentPropsWithoutRef<'a'>) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  )
}

const components: Components = {
  code: CodeRenderer,
  pre: PreRenderer,
  a: LinkRenderer,
}

// ReactMarkdown fallback 子组件：独立 useMemo，符合 Hook 规则
const ReactMarkdownFallback = React.memo(function ReactMarkdownFallback({
  children,
}: {
  children: string
}) {
  const processedText = useMemo(() => {
    if (!children) return ''
    return processLaTeX(children)
  }, [children])

  if (!processedText) return null

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[[rehypeKatex, KATEX_OPTIONS] as any]}
        components={components}
      >
        {processedText}
      </ReactMarkdown>
    </div>
  )
})

// 临时诊断：标记应用级首次 Markdown/KaTeX 渲染
let mdColdStartDone = false

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  children,
  messageId,
  settled,
}: MarkdownRendererProps) {
  if (!children) {
    return null
  }

  if (!mdColdStartDone) {
    mdColdStartDone = true
    console.log('[perf] md-cold-start')
  }

  // HAST cache 路径：仅在 feature flag 开启 + settled + 有 messageId 时生效
  // processLaTeX 由 compileMarkdownToHast 内部调用（cache miss = 1次，cache hit = 0次）
  if (ENABLE_MARKDOWN_HAST_CACHE && settled && messageId) {
    // 缓存命中：render-ready HAST → 直接 toJsxRuntime，无需 processLaTeX
    const cachedHast = hastCacheGet(messageId, children)
    if (cachedHast) {
      return (
        <div className="markdown-body">
          {renderHastToReact(cachedHast, components)}
        </div>
      )
    }

    // 缓存未命中：编译（含 processLaTeX）→ post-transform → render-ready HAST → 写入缓存
    const hast = compileMarkdownToHast(children)
    hastCacheSet(messageId, children, hast)

    return (
      <div className="markdown-body">
        {renderHastToReact(hast, components)}
      </div>
    )
  }

  // 原始 ReactMarkdown 路径（streaming / flag 关闭 / 无 messageId）
  // processLaTeX 在子组件的 useMemo 中调用，仅 1 次
  return <ReactMarkdownFallback>{children}</ReactMarkdownFallback>
})
