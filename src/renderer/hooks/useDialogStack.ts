import { useEffect, useRef } from 'react'

interface StackEntry {
  ref: React.MutableRefObject<() => void>
}

const stack: StackEntry[] = []
let listenerInstalled = false

function installListener() {
  if (listenerInstalled) return
  listenerInstalled = true
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const top = stack[stack.length - 1]
    if (!top) return
    top.ref.current()
  })
}

/**
 * 注册一个「按 ESC 关闭」的处理函数到全局 dialog 栈。
 * 栈顶优先响应，天然支持嵌套 dialog（如设置页里的确认框）。
 */
export function useDialogStack(onClose: () => void, enabled = true) {
  const ref = useRef(onClose)
  ref.current = onClose

  useEffect(() => {
    if (!enabled) return
    installListener()
    const entry: StackEntry = { ref }
    stack.push(entry)
    return () => {
      const idx = stack.indexOf(entry)
      if (idx !== -1) stack.splice(idx, 1)
    }
  }, [enabled])
}