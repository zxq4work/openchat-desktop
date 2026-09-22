import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

// AttachmentService 顶层 import electron 的 nativeImage。本测试不生成图片，
// 只在 DB 中构造参考图行，故用最小 mock 占位（不会被调用）。
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }))

import { StorageService } from '../storage/StorageService'
import { ConversationRepository } from '../storage/ConversationRepository'
import { ContextSegmentRepository } from '../storage/ContextSegmentRepository'
import { AttachmentRepository } from '../storage/AttachmentRepository'
import { AttachmentService } from '../services/attachments/AttachmentService'
import { ImageGenerationRepository } from '../storage/ImageGenerationRepository'
import { ImageGenerationService } from './ImageGenerationService'
import { customImageToImageProfile, customMinimalProfile } from '../../shared/image-generation/parameterProfile'
import type { ImageGenerationParameterProfile, ImageGenerationAdapter } from '../../shared/types/provider'
import type { Conversation, ContextSegment, MessageAttachment } from '../../shared/types/conversation'

// 记录请求的桩 Adapter：不发起网络请求，仅捕获 canonical 请求。
function stubAdapter(captured: unknown[]): ImageGenerationAdapter {
  return {
    protocol: 'image_generations',
    async generate(request) {
      captured.push(request)
      return { images: [{ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' }] }
    },
  }
}

function makeProviderService(profile: ImageGenerationParameterProfile, captured: unknown[]) {
  return {
    getImageAdapter: () => stubAdapter(captured),
    getImageGenerationProfile: () => profile,
    // binding 兼容性门禁会查询当前 Provider registry
    listSafe: () => [{ id: 'prov-1', name: 'Test Image', protocol: 'image_generations', models: ['custom-image-model'] }],
  } as never
}

// runGeneration 经 setImmediate 异步触发；轮询等待 adapter 收到请求。
async function waitForCapture(captured: unknown[], count = 1): Promise<void> {
  for (let i = 0; i < 100 && captured.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function setup(profile: ImageGenerationParameterProfile) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'openchat-img-gen-'))
  const storage = new StorageService(join(dir, 'openchat.db'))
  await storage.init()

  const conversations = new ConversationRepository(storage)
  const segments = new ContextSegmentRepository(storage)

  const now = Date.now()
  const conversation: Conversation = {
    id: 'conv-1',
    type: 'image_generation',
    title: '新对话',
    systemPrompt: '',
    systemPromptRevision: 0,
    defaultModelId: 'custom-image-model',
    defaultReasoningEffort: null,
    currentSegmentId: 'seg-1',
    useModelInstructions: false,
    webSearchEnabled: false,
    codexSearchMode: 'hosted',
    searchEngine: 'bing',
    providerConfigId: 'prov-1',
    defaultImageSize: null,
    defaultImageQuality: null,
    defaultImageBackground: null,
    providerNameSnapshot: null,
    modelNameSnapshot: null,
    createdAt: now,
    updatedAt: now,
  }
  conversations.create(conversation)
  const segment: ContextSegment = {
    id: 'seg-1',
    conversationId: 'conv-1',
    sequence: 1,
    reason: 'conversation-created',
    providerThreadId: null,
    systemPromptRevision: 0,
    systemPromptSnapshot: '',
    createdAt: now,
  }
  segments.create(segment)

  const attachmentRepo = new AttachmentRepository(storage)
  const attachmentService = new AttachmentService(join(dir, 'attachments'), attachmentRepo)

  const captured: unknown[] = []
  const service = new ImageGenerationService(storage, makeProviderService(profile, captured))
  service.setAttachmentService(attachmentService)

  return { dir, storage, attachmentRepo, attachmentService, service, captured, generations: new ImageGenerationRepository(storage) }
}

// 图生图能力 + 显式参考图字段映射（Custom Provider 不再自动补 mapping，必须显式配置）。
function mappedImageToImageProfile(): ImageGenerationParameterProfile {
  return {
    ...customImageToImageProfile(),
    requestMapping: { inputImages: { path: 'extra_body.image', cardinality: 'array', encoding: 'data_url' } },
  }
}

// 直接落一条参考图行（绕开 nativeImage 解码），usage=generation_input，草稿态。
function insertInputDraft(repo: AttachmentRepository, id: string, overrides: Partial<MessageAttachment> = {}): void {
  const now = Date.now()
  repo.create({
    id,
    messageId: null,
    conversationId: 'conv-1',
    segmentId: null,
    type: 'image',
    mimeType: 'image/png',
    fileName: `${id}.png`,
    fileSize: 100,
    width: 10,
    height: 10,
    detail: 'auto',
    sha256: 'deadbeef',
    source: 'user_upload',
    usage: 'generation_input',
    createdAt: now,
    ...overrides,
  })
}

describe('ImageGenerationService — operation resolution (canonical request)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup(mappedImageToImageProfile())
  })

  it('no reference images → text_to_image, no inputImages on the request', async () => {
    await ctx.service.generate('conv-1', 'a blue circle', {})
    const gens = ctx.generations.getByConversationId('conv-1')
    expect(gens).toHaveLength(1)
    expect(gens[0].operation).toBe('text_to_image')
    expect(gens[0].inputImageCount).toBe(0)

    // runGeneration 走 setImmediate，等它把请求交给 adapter
    await waitForCapture(ctx.captured)
    const req = ctx.captured[0] as { inputImages?: unknown[] }
    expect(req.inputImages).toEqual([])
  })

  it('1 reference image → image_to_image, bound to the user message', async () => {
    insertInputDraft(ctx.attachmentRepo, 'att-1')
    const { userMessage } = await ctx.service.generate('conv-1', 'turn it orange', {}, ['att-1'])

    const gens = ctx.generations.getByConversationId('conv-1')
    expect(gens[0].operation).toBe('image_to_image')
    expect(gens[0].inputImageCount).toBe(1)

    // 参考图绑定到 user message（历史重开可见）
    const boundRows = ctx.attachmentRepo.getByMessageId(userMessage.id)
    expect(boundRows.map((r) => r.id)).toEqual(['att-1'])
    expect(userMessage.attachments.map((a) => a.id)).toEqual(['att-1'])
  })

  it('multiple reference images → order preserved in canonical inputImages', async () => {
    insertInputDraft(ctx.attachmentRepo, 'a1')
    insertInputDraft(ctx.attachmentRepo, 'a2')
    await ctx.service.generate('conv-1', 'combine them', {}, ['a1', 'a2'])
    await waitForCapture(ctx.captured)
    const req = ctx.captured[0] as { inputImages?: Array<{ attachmentId: string }> }
    expect(req.inputImages?.map((i) => i.attachmentId)).toEqual(['a1', 'a2'])
  })
})

describe('ImageGenerationService — authoritative validation', () => {
  it('rejects reference images when the profile disables image-to-image', async () => {
    const ctx = await setup(customMinimalProfile())
    insertInputDraft(ctx.attachmentRepo, 'att-1')
    await expect(ctx.service.generate('conv-1', 'x', {}, ['att-1'])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED' })
  })

  it('rejects a non-generation_input attachment (usage mismatch)', async () => {
    const ctx = await setup(customImageToImageProfile())
    // 用 chat_input 冒充参考图
    insertInputDraft(ctx.attachmentRepo, 'chat-img', { usage: 'chat_input' })
    await expect(ctx.service.generate('conv-1', 'x', {}, ['chat-img'])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_INPUT_IMAGE_INVALID' })
  })

  it('rejects an unknown attachment id (never silently degrades to text-to-image)', async () => {
    const ctx = await setup(customImageToImageProfile())
    await expect(ctx.service.generate('conv-1', 'x', {}, ['nope'])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_INPUT_IMAGE_NOT_FOUND' })
  })

  it('rejects beyond maxImages (multiple=true, maxImages=4 → 5 rejected)', async () => {
    const ctx = await setup(mappedImageToImageProfile())
    for (const id of ['1', '2', '3', '4', '5']) insertInputDraft(ctx.attachmentRepo, id)
    await expect(ctx.service.generate('conv-1', 'x', {}, ['1', '2', '3', '4', '5'])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_TOO_MANY_INPUT_IMAGES' })
  })

  it('rejects the 2nd image when multiple=false', async () => {
    const profile = {
      ...mappedImageToImageProfile(),
      operations: { textToImage: true, imageToImage: { enabled: true, multiple: false } },
    }
    const ctx = await setup(profile)
    insertInputDraft(ctx.attachmentRepo, '1')
    insertInputDraft(ctx.attachmentRepo, '2')
    await expect(ctx.service.generate('conv-1', 'x', {}, ['1', '2'])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_TOO_MANY_INPUT_IMAGES' })
  })

  it('rejects reference images when image-to-image is on but no request field is configured', async () => {
    // Custom Provider 绝不自动猜测参考图字段：开启图生图但缺 requestMapping.inputImages 必须拒绝
    const ctx = await setup(customImageToImageProfile())
    insertInputDraft(ctx.attachmentRepo, 'att-1')
    await expect(ctx.service.generate('conv-1', 'x', {}, ['att-1'])).rejects.toMatchObject({ code: 'IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED' })
  })
})
