import { nativeImage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID, createHash } from 'crypto'
import type { AttachmentRepository } from '../../storage/AttachmentRepository'
import type { AttachmentSource, AttachmentUsage, ImageDetail, MessageAttachment } from '../../../shared/types/conversation'
import {
  MAX_IMAGE_BYTES,
  MAX_ORIGINAL_EDGE,
  THUMBNAIL_MAX_EDGE,
  detectImageMime,
  fitWithin,
  mimeToExt,
  type SupportedImageMime,
} from './imageFormat'
import {
  readJpegExifOrientation,
  normalizeBitmapOrientation,
  orientationNeedsTransform,
} from './imageOrientation'

// 孤儿附件保护期：只有"未绑定有效 message、或所属会话/message 已消失"的附件
// 才会在超过该时长后被清理，避免误删刚创建、尚在竞态窗口内的草稿。
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

export class AttachmentError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.code = code
  }
}

// 受控附件文件管理：验证 + 落盘（original/thumbnail）+ DB 记录。
// 图片本体存于 userData/attachments，DB 只保存 metadata。
export class AttachmentService {
  private attachmentsDir: string
  private repo: AttachmentRepository

  constructor(attachmentsDir: string, repo: AttachmentRepository) {
    this.attachmentsDir = attachmentsDir
    this.repo = repo
    this.ensureDirs()
  }

  private get originalsDir(): string { return path.join(this.attachmentsDir, 'originals') }
  private get thumbnailsDir(): string { return path.join(this.attachmentsDir, 'thumbnails') }

  private ensureDirs(): void {
    for (const dir of [this.attachmentsDir, this.originalsDir, this.thumbnailsDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }
  }

  // 由 Main 读取文件字节后调用（renderer 拿不到任意路径，只能通过 dialog / 拖拽路径解析）
  async prepareFromPath(filePath: string, conversationId: string | null, usage: AttachmentUsage = 'chat_input'): Promise<MessageAttachment> {
    let buffer: Buffer
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new AttachmentError('too_large', '图片超过大小上限')
      }
      buffer = fs.readFileSync(filePath)
    } catch (err) {
      if (err instanceof AttachmentError) throw err
      throw new AttachmentError('read_failed', '无法读取图片文件')
    }
    const fileName = path.basename(filePath)
    return this.prepareFromBytes(buffer, fileName, conversationId, usage)
  }

  // usage 区分 Chat 图片输入（chat_input）与图片生成参考图（generation_input）。
  // 两者复用同一落盘/校验/缩略图/去重路径，仅语义不同。
  prepareFromBytes(data: Buffer, fileName: string, conversationId: string | null, usage: AttachmentUsage = 'chat_input'): MessageAttachment {
    return this.persistImage(data, fileName, conversationId, 'user_upload', usage)
  }

  // AI 生成图片走同一落盘/校验/缩略图路径，仅 source 不同。
  // Provider 返回的字节同样必须通过 magic-byte 校验与解码，不因"生成"而跳过安全校验。
  prepareGeneratedImage(data: Buffer, fileName: string, conversationId: string | null): MessageAttachment {
    return this.persistImage(data, fileName, conversationId, 'ai_generated', 'generation_output')
  }

  private persistImage(data: Buffer, fileName: string, conversationId: string | null, source: AttachmentSource, usage: AttachmentUsage): MessageAttachment {
    if (data.length === 0) throw new AttachmentError('empty', '图片为空')
    if (data.length > MAX_IMAGE_BYTES) throw new AttachmentError('too_large', '图片超过大小上限')

    const mime = detectImageMime(data)
    if (!mime) throw new AttachmentError('unsupported', '仅支持 JPEG / PNG / WebP 图片')

    const image = nativeImage.createFromBuffer(data)
    if (image.isEmpty()) throw new AttachmentError('decode_failed', '图片解码失败')

    const size = image.getSize()
    if (!size.width || !size.height) throw new AttachmentError('decode_failed', '无法获取图片尺寸')

    // EXIF 方向归一化：nativeImage 解码不应用 EXIF Orientation，
    // 若直接缩放/重编码会把方向丢掉（缩略图与 Provider 都拿到"横着"的像素）。
    // 这里把旋转/镜像烘焙进像素，之后统一按已归一化的图像处理。
    const orientation = mime === 'image/jpeg' ? readJpegExifOrientation(data) : 1
    const needsOrient = orientationNeedsTransform(orientation)
    let workImage = image
    if (needsOrient) {
      const normalized = normalizeBitmapOrientation(image.toBitmap(), size.width, size.height, orientation)
      const oriented = nativeImage.createFromBitmap(normalized.data, { width: normalized.width, height: normalized.height })
      if (!oriented.isEmpty()) workImage = oriented
    }
    const workSize = workImage.getSize()

    const id = randomUUID()
    const sha256 = createHash('sha256').update(data).digest('hex')

    // 原图：超长边则等比缩放后重新编码，否则原样保存（保留原始字节）。
    // 需要方向归一化时必须重新编码——原始字节仍是"横着"的像素 + EXIF，
    // 而 Provider 解码不认 EXIF。
    const fit = fitWithin(workSize.width, workSize.height, MAX_ORIGINAL_EDGE)
    const ext = mimeToExt(mime)
    const originalPath = path.join(this.originalsDir, `${id}.${ext}`)
    if (fit.scaled || needsOrient) {
      const resized = workImage.resize({ width: fit.width, height: fit.height, quality: 'best' })
      fs.writeFileSync(originalPath, this.encodeImage(resized, mime))
    } else {
      fs.writeFileSync(originalPath, data)
    }

    // 缩略图：最大边 512，只缩小不放大（长边 ≤512 时保留原始尺寸），
    // 但始终重编码（webp 源输出 png，见 thumbExt/thumbMime）。
    const thumbFit = fitWithin(workSize.width, workSize.height, THUMBNAIL_MAX_EDGE)
    const thumbImage = thumbFit.scaled
      ? workImage.resize({ width: thumbFit.width, height: thumbFit.height, quality: 'good' })
      : workImage
    fs.writeFileSync(this.thumbPath(id, mime), this.encodeImage(thumbImage, mime, true))

    const attachment: MessageAttachment = {
      id,
      messageId: null,
      conversationId,
      segmentId: null,
      type: 'image',
      mimeType: mime,
      fileName: fileName || `image.${ext}`,
      fileSize: data.length,
      width: workSize.width,
      height: workSize.height,
      detail: 'auto',
      sha256,
      source,
      usage,
      createdAt: Date.now(),
    }
    this.repo.create(attachment)
    return attachment
  }

  private encodeImage(image: Electron.NativeImage, mime: SupportedImageMime, preferPng = false): Buffer {
    // jpeg 源保持 jpeg（更小）；png/webp 用 png 保留透明
    if (mime === 'image/jpeg' && !preferPng) return image.toJPEG(90)
    if (mime === 'image/jpeg') return image.toJPEG(85)
    return image.toPNG()
  }

  // 缩略图统一重编码：jpeg 源输出 jpg，png/webp 源输出 png。
  // 因此缩略图的真实 MIME 可能与原图不同（webp 原图 → png 缩略图）。
  private thumbExt(mime: SupportedImageMime): string {
    return mime === 'image/jpeg' ? 'jpg' : 'png'
  }

  private thumbMime(mime: SupportedImageMime): string {
    return mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  }

  thumbPath(id: string, mime: string): string {
    const ext = this.thumbExt(mime as SupportedImageMime)
    return path.join(this.thumbnailsDir, `${id}.${ext}`)
  }

  originalPath(id: string, mime: string): string {
    return path.join(this.originalsDir, `${id}.${mimeToExt(mime)}`)
  }

  // 仅接受 attachmentId，由 DB 反查受管路径，杜绝路径穿越 / 任意文件读取
  resolveOriginal(id: string): { filePath: string; mimeType: string } | null {
    const att = this.repo.getById(id)
    if (!att) return null
    return { filePath: this.originalPath(att.id, att.mimeType), mimeType: att.mimeType }
  }

  resolveThumbnail(id: string): { filePath: string; mimeType: string } | null {
    const att = this.repo.getById(id)
    if (!att) return null
    // 缩略图经过重编码，MIME 需用缩略图自身的类型（webp 原图 → png 缩略图）
    return { filePath: this.thumbPath(att.id, att.mimeType), mimeType: this.thumbMime(att.mimeType as SupportedImageMime) }
  }

  // 供 Adapter 读取原始字节并编码（base64 data URL）。返回后由调用方释放。
  // byteSize 用于诊断日志（避免打印 Base64 本体）。
  readForProvider(id: string): { dataUrl: string; mimeType: string; width: number; height: number; detail: ImageDetail; byteSize: number } | null {
    const att = this.repo.getById(id)
    if (!att) return null
    const filePath = this.originalPath(att.id, att.mimeType)
    let buffer: Buffer
    try {
      buffer = fs.readFileSync(filePath)
    } catch {
      return null
    }
    return {
      dataUrl: `data:${att.mimeType};base64,${buffer.toString('base64')}`,
      mimeType: att.mimeType,
      width: att.width,
      height: att.height,
      detail: att.detail,
      byteSize: buffer.length,
    }
  }

  // 参考图字节读取：与 readForProvider 同源，但直接返回 Buffer（Adapter 按需自行编码）。
  // 只接受 attachmentId，由 DB 反查受管路径，杜绝任意路径读取。
  readBytes(id: string): { bytes: Buffer; mimeType: string } | null {
    const att = this.repo.getById(id)
    if (!att) return null
    try {
      const bytes = fs.readFileSync(this.originalPath(att.id, att.mimeType))
      return { bytes, mimeType: att.mimeType }
    } catch {
      return null
    }
  }

  setDetail(id: string, detail: ImageDetail): void {
    this.repo.setDetail(id, detail)
  }

  getAttachment(id: string): MessageAttachment | null {
    return this.repo.getById(id)
  }

  // 只列出指定用途的草稿附件，避免 Chat 图片输入与图片生成参考图互相污染。
  listDrafts(conversationId: string, usage?: AttachmentUsage): MessageAttachment[] {
    const drafts = this.repo.listDrafts(conversationId)
    if (!usage) return drafts
    return drafts.filter((a) => a.usage === usage)
  }

  // 供 Adapter 经 CanonicalModelRequest 注入：把 attachmentId → Provider 可编码信息
  resolveForProvider(id: string) {
    const att = this.repo.getById(id)
    if (!att) return null
    return {
      storagePath: this.originalPath(att.id, att.mimeType),
      mimeType: att.mimeType,
      width: att.width,
      height: att.height,
      detail: att.detail,
    }
  }

  // 供 Image Generation Adapter 注入：把参考图 attachmentId → 真实字节 + MIME。
  resolveForGeneration(id: string): { bytes: Buffer; mimeType: string } | null {
    return this.readBytes(id)
  }

  bindDrafts(attachmentIds: string[], messageId: string, conversationId: string, segmentId: string): void {
    this.repo.bindDraftsToMessage(attachmentIds, messageId, conversationId, segmentId)
  }

  // 删除单条附件（含文件）。文件缺失不阻断删除。
  deleteOne(id: string): void {
    const att = this.repo.getById(id)
    if (att) {
      this.deleteFiles(att)
      this.repo.remove(id)
    }
  }

  deleteForConversation(conversationId: string): void {
    const atts = this.repo.listByConversationId(conversationId)
    for (const att of atts) this.deleteFiles(att)
    this.repo.removeByConversationId(conversationId)
  }

  deleteForConversations(conversationIds: string[]): void {
    const atts = this.repo.listByConversationIds(conversationIds)
    for (const att of atts) this.deleteFiles(att)
    for (const cid of conversationIds) this.repo.removeByConversationId(cid)
  }

  deleteAll(): void {
    const atts = this.repo.listAll()
    for (const att of atts) this.deleteFiles(att)
    this.repo.removeAll()
  }

  // 启动清理：删除未绑定/孤儿附件。
  //
  // 保留条件（唯一）：**已绑定到仍存在的 message，且属于仍存在的会话**。
  //   → 无论多久都保留，绝不因 TTL 清理有效对话数据。
  //
  // 其余（未绑定 message 的 draft，或会话/message 已消失的孤儿）在超过
  // ORPHAN_TTL_MS 保护期后清理。保护期用于避开启动竞态（刚创建、
  // 尚未落库/尚未绑定到会话的附件不能立即当垃圾删掉）。
  //
  // 为什么用"会话是否存在"而不是"message 是否存在"判定孤儿：
  // message_attachments 无外键，且 sql.js 默认不启用 PRAGMA foreign_keys，
  // 删除会话不保证级联删除 messages 行。故会话消失才是可靠的孤儿信号，
  // 否则残留 message 会让 orphan 永远不被清理。
  //
  // 说明（本轮不扩大范围）：
  //   - DB 行存在但托管文件缺失：仅在上述清理路径中一并删行（deleteFiles 容忍文件缺失），
  //     不对"有效绑定"的附件做文件缺失扫描，避免误删有效数据。
  //   - 磁盘有文件但 DB 无记录：无法在不扫描全部托管目录的前提下安全识别，本轮不处理。
  cleanupOrphans(validConversationIds: Set<string>): void {
    const now = Date.now()
    const atts = this.repo.listAll()

    const boundMessageIds = atts.filter((a) => a.messageId).map((a) => a.messageId as string)
    const existingMessageIds = this.repo.existingMessageIds(boundMessageIds)

    for (const att of atts) {
      const boundToLiveMessage = !!att.messageId && existingMessageIds.has(att.messageId)
      const inLiveConversation = !!att.conversationId && validConversationIds.has(att.conversationId)

      // 已绑定有效 message 且会话仍在 → 永久保留（不受 TTL 影响）
      if (boundToLiveMessage && inLiveConversation) continue

      // draft / 孤儿：保护期内保留
      if (now - att.createdAt < ORPHAN_TTL_MS) continue

      this.deleteFiles(att)
      this.repo.remove(att.id)
    }
  }

  private deleteFiles(att: MessageAttachment): void {
    for (const filePath of [this.originalPath(att.id, att.mimeType), this.thumbPath(att.id, att.mimeType)]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      } catch (err) {
        console.error('[AttachmentService] failed to delete file:', filePath, err)
      }
    }
  }
}
