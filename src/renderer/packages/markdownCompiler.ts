/**
 * Markdown 编译器 + post-transform
 *
 * 完整链路：
 *   processLaTeX → unified pipeline → HAST → post-transform (raw→text, URL sanitize)
 *
 * 输出 render-ready HAST：可直接传给 toJsxRuntime，无需再次 visit/mutate。
 * 与 react-markdown v9.0.1 内部行为完全等价。
 */

import type { Root, Element, ElementContent } from 'hast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import { defaultUrlTransform } from 'react-markdown'
import { urlAttributes } from 'html-url-attributes'
import { visit } from 'unist-util-visit'
import { processLaTeX } from './latex'
import { KATEX_OPTIONS } from './katexOptions'

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeKatex, KATEX_OPTIONS as any)

/**
 * 对 hast 执行与 react-markdown v9.0.1 默认行为完全一致的 post-transform：
 * - raw 节点 → text 节点（skipHtml 未设置时的默认行为）
 * - URL 属性经过 defaultUrlTransform 安全化（与 html-url-attributes 一致）
 *
 * 原地修改输入 tree。
 */
function postTransformHast(hast: Root): void {
  visit(hast, (node, index, parent) => {
    // raw → text（react-markdown 默认：skipHtml 未设置时）
    if (node.type === 'raw' && parent && typeof index === 'number') {
      ;(parent as { children: ElementContent[] }).children[index] = {
        type: 'text',
        value: (node as { value: string }).value,
      }
      return index
    }

    // URL sanitize：与 react-markdown 内部 transform 完全一致
    if (node.type === 'element') {
      const el = node as Element
      for (const key in urlAttributes) {
        if (
          Object.prototype.hasOwnProperty.call(urlAttributes, key) &&
          Object.prototype.hasOwnProperty.call(el.properties, key)
        ) {
          const value = el.properties[key]
          const test = (urlAttributes as Record<string, string[] | null>)[key]
          if (test === null || test.includes(el.tagName)) {
            el.properties[key] = defaultUrlTransform(String(value || ''))
          }
        }
      }
    }
  })
}

/**
 * 编译 markdown content 到 render-ready hast tree。
 *
 * 完整链路 = MarkdownRenderer 编译 + react-markdown post-transform，
 * 输出可直接传给 toJsxRuntime，无需再次 visit/mutate。
 */
export function compileMarkdownToHast(content: string): Root {
  const processed = processLaTeX(content)
  const mdast = processor.parse(processed)
  const hast = processor.runSync(mdast, processed) as Root
  postTransformHast(hast)
  return hast
}
