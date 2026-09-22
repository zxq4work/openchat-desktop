// Renderer 侧启动日志：与 Main 的 [boot +Nms] 对齐格式，前缀 R: 区分进程。
// t0 取模块求值时刻（≈ 页面脚本开始执行），用于与 Main 时序对照。
const t0 = typeof performance !== 'undefined' ? performance.now() : 0

export function bootMs(): number {
  return Math.round(performance.now() - t0)
}

export function rlog(msg: string): void {
  console.log(`[boot +${bootMs()}ms] R:${msg}`)
}
