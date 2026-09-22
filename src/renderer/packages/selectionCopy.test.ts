import { describe, it, expect } from 'vitest'
import { rangeWithinElement } from './selectionCopy'

// 轻量 fake：只实现 contains，用于验证「selection 两端是否都落在目标元素内」的核心逻辑。
// 真实 window.getSelection 路径需 DOM 环境（本项目 vitest 为 node，无 jsdom），此处只测包含判定。
function fakeElement(containedNodes: unknown[]): Element {
  return {
    contains: (node: Node) => containedNodes.includes(node),
  } as unknown as Element
}

function fakeRange(start: unknown, end: unknown): Range {
  return { startContainer: start, endContainer: end } as unknown as Range
}

describe('rangeWithinElement', () => {
  const nodeA = {}
  const nodeB = {}

  it('true when both ends belong to the element', () => {
    expect(rangeWithinElement(fakeRange(nodeA, nodeB), fakeElement([nodeA, nodeB]))).toBe(true)
  })

  it('false when start belongs to another message', () => {
    expect(rangeWithinElement(fakeRange(nodeB, nodeA), fakeElement([nodeA]))).toBe(false)
  })

  it('false when end belongs to another message', () => {
    expect(rangeWithinElement(fakeRange(nodeA, nodeB), fakeElement([nodeA]))).toBe(false)
  })

  it('false when selection spans two messages (neither end fully inside)', () => {
    const other = {}
    expect(rangeWithinElement(fakeRange(other, other), fakeElement([nodeA, nodeB]))).toBe(false)
  })
})
