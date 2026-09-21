// IPC 错误文案清洗。
//
// Main 侧 `ipcMain.handle` 抛出的错误经 Electron 序列化后，Renderer 收到的
// `Error.message` 会被加上前后缀，例如：
//   "Error occurred in handler for 'image-generation:generate': ImageGenerationError: 当前图片供应商不支持参数「输出格式」"
// 这些前缀是实现细节（handler 名 / 错误类名），直接展示给用户会造成噪音，
// 也让真正的可操作原因（参数名、Provider 摘要）被淹没。
//
// 这里只剥离 Electron 固定前缀与错误类名前缀，保留原始的业务文案。
const HANDLER_PREFIX = /^Error occurred in handler for '[^']*':\s*/
const ERROR_CLASS_PREFIX = /^[A-Za-z][A-Za-z0-9_]*Error:\s*/
// Electron 有时会把原始堆栈一并序列化到 message 里，尾部栈帧（"  at foo (file:1:2)"）对用户无意义。
const STACK_FRAME = /\n\s*at\s[\s\S]*$/

export function cleanIpcErrorMessage(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw ?? '')
  return message
    .replace(HANDLER_PREFIX, '')
    .replace(ERROR_CLASS_PREFIX, '')
    .replace(STACK_FRAME, '')
    .trim()
}
