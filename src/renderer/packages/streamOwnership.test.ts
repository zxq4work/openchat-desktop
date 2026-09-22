import { describe, it, expect } from 'vitest'
import {
  ownsChatStream,
  ownsImageGeneration,
  isStreamOwner,
  selectAnswerContent,
  shouldShowWaitingIndicator,
} from './streamOwnership'

// 跨会话运行状态隔离：状态只能展示在它所属的会话视图里。

describe('ownsChatStream (chat stream stays in its own conversation)', () => {
  it('active = chat A, streaming = chat A => true', () => {
    expect(ownsChatStream('chat', 'A', 'A')).toBe(true)
  })

  it('active = chat B, streaming = chat A => false', () => {
    expect(ownsChatStream('chat', 'B', 'A')).toBe(false)
  })

  it('active = image A, streaming = chat B => false', () => {
    expect(ownsChatStream('image_generation', 'A', 'B')).toBe(false)
  })

  it('active = image A, streaming = image A => false', () => {
    expect(ownsChatStream('image_generation', 'A', 'A')).toBe(false)
  })

  it('no active conversation / no streaming => false', () => {
    expect(ownsChatStream('chat', null, 'A')).toBe(false)
    expect(ownsChatStream('chat', 'A', null)).toBe(false)
    expect(ownsChatStream(null, 'A', 'A')).toBe(false)
  })
})

describe('ownsImageGeneration (image generation stays in its own conversation)', () => {
  it('active = image A, generating = image A => true', () => {
    expect(ownsImageGeneration('image_generation', 'A', 'A')).toBe(true)
  })

  it('active = image B, generating = image A => false', () => {
    expect(ownsImageGeneration('image_generation', 'B', 'A')).toBe(false)
  })

  it('active = chat A, generating = image B => false', () => {
    expect(ownsImageGeneration('chat', 'A', 'B')).toBe(false)
  })

  it('active = chat A, generating = chat A id => false', () => {
    expect(ownsImageGeneration('chat', 'A', 'A')).toBe(false)
  })
})

// isStreamOwner：live answer 归属必须 conversationId + messageId 双匹配。
describe('isStreamOwner (live stream requires conversationId AND messageId match)', () => {
  it('Case 1: conv=A msg=M2, owner=(A,M2) => true', () => {
    expect(isStreamOwner('A', 'M2', 'A', 'M2')).toBe(true)
  })

  it('Case 2: conv=A msg=M1 (≠M2) => false, even if M1.status === streaming', () => {
    // 同一 conversation 内的历史/其它 assistant message 绝不采用 live answer。
    // 注意：status 根本不参与判定 —— DB 历史遗留的 streaming 状态不构成 owner。
    expect(isStreamOwner('A', 'M1', 'A', 'M2')).toBe(false)
  })

  it('Case 3: conv=B msg=M2 => false (conversationId 必须匹配)', () => {
    expect(isStreamOwner('B', 'M2', 'A', 'M2')).toBe(false)
  })

  it('missing streaming ids => false', () => {
    expect(isStreamOwner('A', 'M2', null, 'M2')).toBe(false)
    expect(isStreamOwner('A', 'M2', 'A', null)).toBe(false)
    expect(isStreamOwner('A', 'M2', null, null)).toBe(false)
  })

  it('old OR-style behaviour (activeAssistantMessageId only) must NOT grant ownership', () => {
    // 旧的 isMessageAdoptedByLiveStream 用 OR（会话匹配 或 active id 匹配），过宽：
    // 会将 live buffer 串到同会话的历史消息上，或在 active id 残留时误判。
    // 新语义只认双匹配：conv 匹配但 msg 不匹配 → false。
    expect(isStreamOwner('A', 'M1', 'A', 'M2')).toBe(false)
  })
})

// selectAnswerContent：唯一事实源，绝不 persisted + live 叠加。
describe('selectAnswerContent (single source of truth, no double-merge)', () => {
  it('Case 4: hydrate persisted ""→"ABC" while live answer is "ABCDE" => render "ABCDE" (never "ABCABCDE")', () => {
    // 场景：stream 期间点击 active conversation 触发 hydrate，
    // message.content 由 '' 变为 'ABC'（DB 中途落盘），live answer 累计为 'ABCDE'。
    expect(selectAnswerContent('', 'ABCDE', true)).toBe('ABCDE')
    // 再次 hydrate，persisted 变成 'ABC'：
    expect(selectAnswerContent('ABC', 'ABCDE', true)).toBe('ABCDE')
    // 无论 persisted 怎样变化，owner 渲染恒等于 live answer → 单调增长不被破坏。
    expect(selectAnswerContent('ABCD', 'ABCDE', true)).toBe('ABCDE')
  })

  it('non-owner always renders persisted content', () => {
    expect(selectAnswerContent('历史正文', 'ABCDE', false)).toBe('历史正文')
  })

  it('owner with empty live answer renders empty (does NOT fall back to persisted)', () => {
    // 若回退到 persisted，会在切回/relog 时露出一段本该由 live 表达的旧文本，
    // 且随后 live 到达会产生跳变。
    expect(selectAnswerContent('ABC', '', true)).toBe('')
  })
})

// shouldShowWaitingIndicator：全局唯一的「等待回答」判据。
describe('shouldShowWaitingIndicator (single canonical waiting indicator)', () => {
  it('Case 5: live owner, chat, streaming, no answer => true', () => {
    expect(
      shouldShowWaitingIndicator({
        isLiveOwner: true,
        conversationType: 'chat',
        messageStatus: 'streaming',
        hasVisibleAnswerContent: false,
      })
    ).toBe(true)
  })

  it('Case 6: live owner, chat, streaming, answer "A" => false (首段正文出现即隐藏)', () => {
    expect(
      shouldShowWaitingIndicator({
        isLiveOwner: true,
        conversationType: 'chat',
        messageStatus: 'streaming',
        hasVisibleAnswerContent: true,
      })
    ).toBe(false)
  })

  it('Case 7: image generation conversation => false', () => {
    expect(
      shouldShowWaitingIndicator({
        isLiveOwner: true,
        conversationType: 'image_generation',
        messageStatus: 'streaming',
        hasVisibleAnswerContent: false,
      })
    ).toBe(false)
  })

  it('non-owner streaming message => false (历史遗留 streaming 状态不显示等待提示)', () => {
    expect(
      shouldShowWaitingIndicator({
        isLiveOwner: false,
        conversationType: 'chat',
        messageStatus: 'streaming',
        hasVisibleAnswerContent: false,
      })
    ).toBe(false)
  })

  it("status 'pending' (renderer optimistic initial state) also counts as waiting => true", () => {
    // 渲染进程的乐观 assistant 消息沿用 Main 的 'pending'，直到 turn-completed 才变 'completed'。
    // 因此 waiting 必须同时覆盖 'pending' 与 'streaming'，否则等待提示根本不显示。
    expect(
      shouldShowWaitingIndicator({
        isLiveOwner: true,
        conversationType: 'chat',
        messageStatus: 'pending',
        hasVisibleAnswerContent: false,
      })
    ).toBe(true)
  })

  it('settled statuses => false regardless of content', () => {
    for (const status of ['completed', 'stopped', 'failed', 'idle']) {
      expect(
        shouldShowWaitingIndicator({
          isLiveOwner: true,
          conversationType: 'chat',
          messageStatus: status,
          hasVisibleAnswerContent: false,
        })
      ).toBe(false)
    }
  })

  it('null conversation type => false', () => {
    expect(
      shouldShowWaitingIndicator({
        isLiveOwner: true,
        conversationType: null,
        messageStatus: 'streaming',
        hasVisibleAnswerContent: false,
      })
    ).toBe(false)
  })
})
