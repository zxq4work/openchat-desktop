import type { AttachmentUsage, MessageAttachment } from '../../shared/types/conversation'
import { MAX_IMAGES_PER_MESSAGE } from '../../shared/constants'

// renderer 导入的草稿只能是「用户输入类」用途：Chat 图片输入 / 图片生成参考图。
// generation_output 由 Main 生成结果落盘时产生，renderer 永远不导入，故从参数类型中排除。
export type ImportUsage = Exclude<AttachmentUsage, 'generation_output'>

export interface ImportOutcome {
  attachments: MessageAttachment[]
  errors: Array<{ fileName: string; code: string; message: string }>
}

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

// 从 renderer 的 File 对象导入图片：读取字节 → IPC prepareFromBytes。
// Electron 22 无 webUtils.getPathForFile，renderer 拿不到磁盘路径，
// 因此统一走字节通道（Main 侧按 magic bytes 校验真实 MIME）。
// usage 区分 Chat 图片输入（chat_input）与图片生成参考图（generation_input）；
// maxSlots 为本次允许导入的最大数量（由调用方按场景计算）。
export async function importFiles(
  files: File[],
  conversationId: string | null,
  remainingSlots: number,
  usage: ImportUsage = 'chat_input',
  maxSlots: number = MAX_IMAGES_PER_MESSAGE
): Promise<ImportOutcome> {
  const attachments: MessageAttachment[] = []
  const errors: ImportOutcome['errors'] = []

  for (const file of files) {
    if (attachments.length >= remainingSlots) {
      errors.push({ fileName: file.name, code: 'too_many_images', message: `最多 ${maxSlots} 张图片` })
      continue
    }
    if (!file.type || !SUPPORTED_TYPES.has(file.type)) {
      errors.push({ fileName: file.name, code: 'unsupported_type', message: '仅支持 JPEG / PNG / WebP 图片' })
      continue
    }
    try {
      const buffer = new Uint8Array(await file.arrayBuffer())
      const att = await window.openchat.attachments.prepareFromBytes(conversationId, file.name, buffer, usage)
      attachments.push(att)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const root = raw.split(':')[0].trim()
      errors.push({ fileName: file.name, code: 'attachment_failed', message: root || '处理失败' })
    }
  }

  return { attachments, errors }
}

// 从拖拽/粘贴的 DataTransferItemList 中筛出图片文件。
export function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && (!file.type || file.type.startsWith('image/'))) out.push(file)
  }
  return out
}
