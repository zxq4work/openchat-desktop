import { describe, it, expect } from 'vitest'
import {
  canAddImages,
  getSendBlockReason,
  blockReasonMessage,
  IMAGE_ADD_REJECTED_MESSAGE,
  DRAFT_IMAGE_INCOMPATIBLE_MESSAGE,
  HISTORY_IMAGE_INCOMPATIBLE_MESSAGE,
} from './imageInputCompatibility'

// canAddImages：决定 paste / drop / picker 是否可用（新增问题）
describe('canAddImages', () => {
  it('supported → true', () => {
    expect(canAddImages(true)).toBe(true)
  })
  it('unsupported → false', () => {
    expect(canAddImages(false)).toBe(false)
  })
})

// getSendBlockReason：决定 Send 是否可用及原因（发送兼容性问题）
describe('getSendBlockReason', () => {
  it('TEST 1: unsupported + pure text + no history image → no block (send allowed)', () => {
    expect(getSendBlockReason({ supportsImage: false, draftImageCount: 0, historyNeedsImage: false })).toBeNull()
  })

  it('TEST 2: unsupported + draft image → draft_images_unsupported', () => {
    expect(getSendBlockReason({ supportsImage: false, draftImageCount: 1, historyNeedsImage: false })).toBe('draft_images_unsupported')
  })

  it('TEST 3: supported + draft image → no block', () => {
    expect(getSendBlockReason({ supportsImage: true, draftImageCount: 2, historyNeedsImage: false })).toBeNull()
  })

  it('TEST 5: unsupported + no draft image + history image → history_images_unsupported', () => {
    expect(getSendBlockReason({ supportsImage: false, draftImageCount: 0, historyNeedsImage: true })).toBe('history_images_unsupported')
  })

  it('draft reason takes precedence over history reason (removable before non-removable)', () => {
    expect(getSendBlockReason({ supportsImage: false, draftImageCount: 1, historyNeedsImage: true })).toBe('draft_images_unsupported')
  })

  it('supported + draft + history → no block', () => {
    expect(getSendBlockReason({ supportsImage: true, draftImageCount: 3, historyNeedsImage: true })).toBeNull()
  })
})

describe('blockReasonMessage / unified copy', () => {
  it('draft reason → draft message', () => {
    expect(blockReasonMessage('draft_images_unsupported')).toBe(DRAFT_IMAGE_INCOMPATIBLE_MESSAGE)
  })
  it('history reason → history message', () => {
    expect(blockReasonMessage('history_images_unsupported')).toBe(HISTORY_IMAGE_INCOMPATIBLE_MESSAGE)
  })
  it('three messages are distinct (no copy collision)', () => {
    const set = new Set([IMAGE_ADD_REJECTED_MESSAGE, DRAFT_IMAGE_INCOMPATIBLE_MESSAGE, HISTORY_IMAGE_INCOMPATIBLE_MESSAGE])
    expect(set.size).toBe(3)
  })
})
