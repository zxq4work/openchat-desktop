import React, { useMemo } from 'react'
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

function CodeRenderer({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'>) {
  return (
    <code className={className} {...props}>
      {children}
    </code>
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