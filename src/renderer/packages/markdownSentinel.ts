/**
 * Markdown sentinel 清理插件。
 *
 * processLaTeX 为修复 `**` flanking 判定，会在 TEXT 状态临时插入
 * BOLD_SENTINEL（U+FDD0）。该字符只在 micromark 解析阶段参与 delimiter
 * 邻接字符分类，绝不能进入最终 DOM / clipboard。
 *
 * 本插件在 parse 之后、编译到 HAST 之前运行，从 mdast 文本类节点精确移除
 * 该 sentinel。只删除我们自己插入的 sentinel，不影响用户/模型原文中的
 * 任何其他字符（合法 U+200B 等均保留）。
 */

import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'
import { BOLD_SENTINEL } from './latex'

export function remarkStripBoldSentinel() {
  return (tree: Root) => {
    // sentinel 只在 TEXT 状态插入，因此只会出现在 text 节点中
    visit(tree, 'text', (node) => {
      if (node.value.includes(BOLD_SENTINEL)) {
        node.value = node.value.split(BOLD_SENTINEL).join('')
      }
    })
  }
}
