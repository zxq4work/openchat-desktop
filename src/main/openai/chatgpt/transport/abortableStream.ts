// SSE 响应读取循环的取消唤醒桥。
//
// 背景：三个 SSE 适配器（ChatGPTCodexClient / ResponsesAdapter / ChatCompletionsAdapter）
// 都在「响应头到达后」进入逐块读取循环，通过 `await new Promise(resolve => { notify = resolve })`
// 等待下一块数据。该 Promise 原先只由 response 的 data/end/error 事件唤醒。
//
// 但 abort 路径调用的是 `req.destroy()`（不传 Error）。在 Electron net（system 代理模式）下，
// `ClientRequest.abort()` 按 API 约定只 emit `abort` + `close`（响应对象 emit `aborted`），
// 绝不 emit `error`；在 Node http 下对已收到的响应通常也只 emit `aborted`/`close`。
// 于是「响应头已到、正文还在等待」时取消，读取循环的 await 永远不被唤醒
// → 生成任务无法退出 → activeGeneration 永不释放 → 再次发送报「已有正在进行的生成」。
//
// 本模块把 AbortSignal 触发、response 的 close/aborted 统一收敛为一个「读取应终止」信号，
// 让读取循环可靠退出，并保证监听器在正常结束/异常结束时都被清理。

export interface AbortableStreamState {
  // 取消（用户主动停止）或响应异常关闭时为 true。
  isAborted(): boolean
  // 响应异常关闭（close/aborted 早于 end，且非取消）时的错误；否则 null。
  abortReason(): Error | null
  // 由读取循环的 end/error 处理器调用，标记响应已正常/已知结束，
  // 使随后到达的 close 不被误判为「异常关闭」。
  markEnded(): void
  // 移除全部监听器。必须幂等，可在 finally 与各终止分支重复调用。
  cleanup(): void
}

// 响应对象只用到这两个事件的注册/移除；用最小结构类型描述，兼容 Node 与 Electron。
export interface AbortableResponseStream {
  on(event: 'close', listener: () => void): unknown
  on(event: 'aborted', listener: () => void): unknown
  removeListener?(event: 'close' | 'aborted', listener: () => void): unknown
}

// 取消时抛出的统一错误。name 设为 AbortError，便于调用方识别；
// message 与既有 abort 路径（reject(new Error('Aborted'))）保持一致。
export function makeAbortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

export function installStreamAbortBridge(
  stream: AbortableResponseStream,
  signal: AbortSignal | undefined,
  wake: () => void
): AbortableStreamState {
  let abortedFlag = false
  let ended = false
  let closeError: Error | null = null

  const onSignalAbort = () => {
    abortedFlag = true
    wake()
  }

  // 'close' 是响应对象的最后事件。正常结束（end 已触发）后 close 属于收尾；
  // 若 close 早于 end，说明连接在传输中途异常关闭。
  const onClose = () => {
    if (ended) return
    // abort 路径的 req.destroy() 会先令响应 emit aborted/close，再触发 signal 'abort' 监听；
    // 这里重新核对 signal 状态，避免把用户主动取消误判为「异常关闭」。
    if (signal?.aborted) abortedFlag = true
    else if (!abortedFlag) closeError = new Error('Stream closed unexpectedly')
    wake()
  }

  // 'aborted'：响应在传输完成前被中断（如 Node 的 res.destroy()）。
  const onAborted = () => {
    if (ended) return
    if (signal?.aborted) abortedFlag = true
    else if (!abortedFlag) closeError = new Error('Stream aborted unexpectedly')
    wake()
  }

  if (signal) {
    if (signal.aborted) abortedFlag = true
    else signal.addEventListener('abort', onSignalAbort, { once: true })
  }
  stream.on('close', onClose)
  stream.on('aborted', onAborted)

  return {
    isAborted: () => abortedFlag,
    abortReason: () => closeError,
    markEnded() {
      ended = true
    },
    cleanup() {
      if (signal) signal.removeEventListener('abort', onSignalAbort)
      if (typeof stream.removeListener === 'function') {
        stream.removeListener('close', onClose)
        stream.removeListener('aborted', onAborted)
      }
    },
  }
}
