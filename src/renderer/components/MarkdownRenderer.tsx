import React, { useMemo, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import rehypeKatex from 'rehype-katex'
import { processLaTeX } from '../packages/latex'

interface MarkdownRendererProps {
  children: string
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

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  children,
}: MarkdownRendererProps) {
  const processedText = useMemo(() => {
    if (!children) return ''
    return processLaTeX(children)
  }, [children])

  if (!processedText) {
    return null
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {processedText}
      </ReactMarkdown>
    </div>
  )
})