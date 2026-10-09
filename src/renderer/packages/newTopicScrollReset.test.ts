/**
 * Cmd/Ctrl+R「重置上下文后强制贴底」回归测试。
 *
 * 背景（回归根因）：
 *   滚动机制重构后，MessageList 的自动贴底改由 followMode/pinned 状态机 + 条件
 *   effect 驱动。Cmd+R 走「onNewTopic → conversations.get → setActiveMessages/
 *   setActiveSegments」替换式刷新：messages 数组引用必变、segments.length 也 +1，
 *   因此 [messages, segments.length] 那条条件 effect 确实会重新执行——
 *   但它只做「FOLLOWING && pinned 才贴底」。用户若正在看历史（READING_HISTORY /
 *   pinned=false），effect 命中 else 分支，只更新「回到底部」按钮，绝不滚动。
 *   于是 Cmd+R 后停在原处，不再自动到底部。
 *
 * 修复：把「用户显式要求贴底」与「新消息到达时的条件自动滚动」在语义上区分开——
 *   通过 uiStore.newTopicResetRequestId（只增计数器）下发一次显式导航请求，
 *   MessageList 订阅后用 store 水位线 consumeNewTopicScrollIfPending() 消费一次。
 *
 * 为什么用「store 水位线」而不是组件局部 ref 判定消费：
 *   useEffect 在组件每次挂载后都会执行（依赖数组只控制后续更新）。
 *   MessageList 会在「initError→恢复」「空会话首次进入」等路径卸载/重挂载。
 *   若用局部 ref 的初始值判消费，重挂载后首次 effect 会再次消费历史请求 → 重复贴底；
 *   水位线跨挂载存活，保证每个请求恰好消费一次，且未挂载期间发出的请求不遗漏。
 *
 * 本测试直接驱动**生产逻辑**（uiStore 的 request/consume 动作），而非复刻判断式：
 *   1. store 契约：request 自增、与 focusRequestId 独立、初始水位线为 0；
 *   2. 消费语义：每个请求恰好消费一次；重挂载/重复 effect 不重复消费；
 *      卸载期间发出、重挂载后消费 → 不遗漏；
 *   3. 跨会话竞态：刷新期间切走会话则丢弃本次刷新与贴底（shouldApplyNewTopicRefresh）；
 *   4. 源码契约：App.tsx 用最新 activeConversationId 做守卫并在其后下发请求；
 *      MessageList 经 store 水位线消费。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { useUiStore } from '../stores/uiStore'
import { shouldApplyNewTopicRefresh } from './newTopicRefresh'

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

// 每次挂载后 MessageList 的贴底 effect 都会执行；用生产 store 动作模拟「一次 effect 执行」。
function runMessageListScrollEffect(): boolean {
  return useUiStore.getState().consumeNewTopicScrollIfPending()
}

describe('Cmd/Ctrl+R 重置上下文后强制贴底', () => {
  beforeEach(() => {
    useUiStore.setState({ newTopicResetRequestId: 0, consumedNewTopicResetRequestId: 0, focusRequestId: 0 })
  })

  // ===== store 契约 =====
  it('初始 request=0，请求一次后自增 1', () => {
    expect(useUiStore.getState().newTopicResetRequestId).toBe(0)
    useUiStore.getState().requestScrollToBottomAfterReset()
    expect(useUiStore.getState().newTopicResetRequestId).toBe(1)
  })

  it('连续请求单调递增（每次 Cmd+R 一次新请求）', () => {
    useUiStore.getState().requestScrollToBottomAfterReset()
    useUiStore.getState().requestScrollToBottomAfterReset()
    useUiStore.getState().requestScrollToBottomAfterReset()
    expect(useUiStore.getState().newTopicResetRequestId).toBe(3)
  })

  it('与 requestComposerFocus 相互独立', () => {
    useUiStore.getState().requestScrollToBottomAfterReset()
    useUiStore.getState().requestComposerFocus()
    expect(useUiStore.getState().newTopicResetRequestId).toBe(1)
    expect(useUiStore.getState().focusRequestId).toBe(1)
    useUiStore.getState().requestComposerFocus()
    expect(useUiStore.getState().newTopicResetRequestId).toBe(1)
    expect(useUiStore.getState().focusRequestId).toBe(2)
  })

  // ===== 消费语义（针对真实回归）=====
  it('无请求时 effect 不消费（首次挂载、id=0）', () => {
    expect(runMessageListScrollEffect()).toBe(false)
    expect(useUiStore.getState().consumedNewTopicResetRequestId).toBe(0)
  })

  it('请求后恰好消费一次：首次 effect 贴底，重复 effect 不再贴底（StrictMode / 重挂载）', () => {
    useUiStore.getState().requestScrollToBottomAfterReset()
    // 首次挂载后的 effect：消费并贴底
    expect(runMessageListScrollEffect()).toBe(true)
    // 同一请求的第二次 effect 执行（StrictMode 双调用 / 组件重挂载）：不再消费
    expect(runMessageListScrollEffect()).toBe(false)
    expect(runMessageListScrollEffect()).toBe(false)
    expect(useUiStore.getState().consumedNewTopicResetRequestId).toBe(1)
  })

  it('卸载期间发出、重挂载后才执行 effect：不遗漏该请求', () => {
    // 组件未挂载时用户按了 Cmd+R
    useUiStore.getState().requestScrollToBottomAfterReset()
    // 直到重新挂载才有 effect 执行 → 必须消费到这次请求
    expect(runMessageListScrollEffect()).toBe(true)
  })

  it('每个请求各消费一次，顺序推进水位线', () => {
    useUiStore.getState().requestScrollToBottomAfterReset()
    useUiStore.getState().requestScrollToBottomAfterReset()
    expect(runMessageListScrollEffect()).toBe(true)
    expect(useUiStore.getState().consumedNewTopicResetRequestId).toBe(2)
    expect(runMessageListScrollEffect()).toBe(false)
    // 再来一次新请求（如切到另一会话后 Cmd+R）
    useUiStore.getState().requestScrollToBottomAfterReset()
    expect(runMessageListScrollEffect()).toBe(true)
    expect(useUiStore.getState().consumedNewTopicResetRequestId).toBe(3)
  })

  // ===== 跨会话竞态：刷新期间切走会话 =====
  it('刷新期间切到别的会话 / 关闭会话：丢弃本次刷新与贴底', () => {
    expect(shouldApplyNewTopicRefresh('conv-B', 'conv-A')).toBe(false)
    expect(shouldApplyNewTopicRefresh(null, 'conv-A')).toBe(false)
  })

  it('会话未变：正常应用刷新与贴底', () => {
    expect(shouldApplyNewTopicRefresh('conv-A', 'conv-A')).toBe(true)
  })

  // ===== 源码契约（接线，防回归）=====
  it('App.tsx：用最新 activeConversationId 做跨会话守卫，随后下发请求', () => {
    const app = readSrc('src/renderer/app/App.tsx')
    const handler = app.match(/onNewTopic\(async[\s\S]*?\n    \}\)/)
    expect(handler, 'onNewTopic handler 未找到').toBeTruthy()
    const body = handler![0]
    // 守卫参数必须是 await 之后重新读取的 store 值，而非入口闭包里的旧 id
    expect(body).toMatch(/shouldApplyNewTopicRefresh\(\s*useConversationStore\.getState\(\)\.activeConversationId\s*,\s*id\s*\)/)
    const guard = body.indexOf('shouldApplyNewTopicRefresh')
    const setSeg = body.indexOf('setActiveSegments')
    const request = body.indexOf('requestScrollToBottomAfterReset')
    expect(guard, '守卫未找到').toBeGreaterThanOrEqual(0)
    expect(setSeg, 'setActiveSegments 未找到').toBeGreaterThan(guard)
    expect(request, 'requestScrollToBottomAfterReset 未找到').toBeGreaterThan(setSeg)
  })

  it('MessageList：经 store 水位线消费，且不依赖局部 ref 判定', () => {
    const src = readSrc('src/renderer/components/chat/MessageList.tsx')
    expect(src).toMatch(/consumeNewTopicScrollIfPending\(\)/)
    // effect 依赖必须含 request id，才能在请求变化时重新执行
    expect(src).toMatch(/\[newTopicResetRequestId\]/)
    // 不得再用「局部 ref 初始值 + 与 request id 比较」的判消费写法
    expect(src).not.toMatch(/newTopicResetRequestId <= 0/)
    expect(src).not.toMatch(/newTopicResetRequestId <= last/)
  })
})
