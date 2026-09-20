import type { MessageAttachment } from '../../shared/types/conversation'
import { MAX_IMAGES_PER_MESSAGE } from '../../shared/constants'

export interface ImportOutcome {
  attachments: MessageAttachment[]
  errors: Array<{ fileName: string; message: string }>
}

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

// 从 renderer 的 File 对象导入图片：读取字节 → IPC prepareFromBytes。
// Electron 22 无 webUtils.getPathForFile，renderer 拿不到磁盘路径，
// 因此统一走字节通道（Main 侧按 magic bytes 校验真实 MIME）。
export async function importFiles(
  files: File[],
  conversationId: string | null,
  remainingSlots: number
): Promise<ImportOutcome> {
  const attachments: MessageAttachment[] = []
  const errors: ImportOutcome['errors'] = []

  for (const file of files) {
    if (attachments.length >= remainingSlots) {
      errors.push({ fileName: file.name, message: `最多 ${MAX_IMAGES_PER_MESSAGE} 张图片` })
      continue
    }
    if (!file.type || !SUPPORTED_TYPES.has(file.type)) {
      errors.push({ fileName: file.name, message: '仅支持 JPEG / PNG / WebP 图片' })
      continue
    }
    try {
      const buffer = new Uint8Array(await file.arrayBuffer())
      const att = await window.openchat.attachments.prepareFromBytes(conversationId, file.name, buffer)
      attachments.push(att)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const root = raw.split(':')[0].trim()
      errors.push({ fileName: file.name, message: root || '处理失败' })
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
