import { useUiStore, type ContextMenuItem } from '../stores/uiStore'
import { copyText } from './clipboard'
import { copyAttachmentImage } from './imageCopy'
import { getSelectionWithinElement } from './selectionCopy'
import { searchInBrowser } from './browserSearch'

// React.MouseEvent 的结构子集，避免为一个事件类型引入 React 运行时依赖。
interface MenuEvent {
  preventDefault: () => void
  stopPropagation: () => void
  clientX: number
  clientY: number
}

// 选区内右键菜单：仅在当前消息内确有选区时使用。
// 「复制」只复制选中文字；「在浏览器中搜索」用同一段选中文字（复用既有实现）。
export function buildSelectionMenu(selectedText: string): ContextMenuItem[] {
  return [
    { id: 'copy', label: '复制', onClick: () => copyText(selectedText) },
    { id: 'search', label: '在浏览器中搜索', onClick: () => { void searchInBrowser(selectedText) } },
  ]
}

// 未选中文字、右键文字区域：语义为「复制文本」——只复制 message.content 原文，
// 不混入 reasoning / 工具状态 / 搜索结果 UI / 代码按钮 / 时间 / footer。
export function buildMessageTextMenu(content: string): ContextMenuItem[] {
  return [{ id: 'copy-text', label: '复制文本', onClick: () => copyText(content) }]
}

// 图片右键菜单：target 是图片，故「复制图片」优先；若消息还有文字，追加「复制文本」。
// 不使用会让用户误以为「图片+文字一起复制」的措辞。
export function buildMessageImageMenu(attachmentId: string, messageContent?: string | null): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: 'copy-image', label: '复制图片', onClick: () => { void copyAttachmentImage(attachmentId) } },
  ]
  if (messageContent && messageContent.trim()) {
    items.push({ id: 'copy-text', label: '复制文本', onClick: () => copyText(messageContent) })
  }
  return items
}

// 消息根节点右键：
//   1) 当前消息内有自己的选区 → selection 菜单（复制 / 在浏览器中搜索）
//   2) 否则 message.content 非空 → 复制文本
//   3) 内容为空（纯图片消息）→ 不打开菜单
// 选区必须属于当前消息：getSelectionWithinElement 只在本消息内取文本，
// 避免「A 选中、右键 B」时误用 A 的选区。
export function openMessageContextMenu(e: MenuEvent, root: HTMLElement, content: string): void {
  const selected = getSelectionWithinElement(root).trim()
  if (selected) {
    e.preventDefault()
    e.stopPropagation()
    useUiStore.getState().openContextMenu(e.clientX, e.clientY, buildSelectionMenu(selected))
    return
  }
  if (!content || !content.trim()) return
  e.preventDefault()
  e.stopPropagation()
  useUiStore.getState().openContextMenu(e.clientX, e.clientY, buildMessageTextMenu(content))
}

// 消息内图片右键：调用方必须 stopPropagation 阻止冒泡到消息根节点。
export function openImageContextMenu(e: MenuEvent, attachmentId: string, messageContent?: string | null): void {
  e.preventDefault()
  e.stopPropagation()
  useUiStore.getState().openContextMenu(e.clientX, e.clientY, buildMessageImageMenu(attachmentId, messageContent))
}
