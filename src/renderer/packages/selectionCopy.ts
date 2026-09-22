// Range 的 start/end 是否都落在 element 之内。
// Node.contains 对 Text 节点有效；跨节点 selection 时 startContainer / endContainer 可能
// 位于不同元素 —— 只有两端都属于当前消息，才算「属于本消息的选区」。
// 不能只检查 commonAncestorContainer：跨两条消息选择时，公共祖先可能是消息列表容器，
// 会把别的消息的选区误判为当前消息。
export function rangeWithinElement(range: Range, element: Element): boolean {
  return element.contains(range.startContainer) && element.contains(range.endContainer)
}

// 取「完全落在 element 之内」的选区文本。选中别的消息、或选择跨消息时返回 ''。
// 不读取全局旧选区作为完整消息复制的依据 —— 调用方据返回值决定是否走 selection 分支。
export function getSelectionWithinElement(element: Element | null): string {
  if (!element) return ''
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const range = selection.getRangeAt(0)
  if (!rangeWithinElement(range, element)) return ''
  return selection.toString()
}
