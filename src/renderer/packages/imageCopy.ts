import { useUiStore } from '../stores/uiStore'

// 复制受管图片到位图剪贴板。renderer 只传 attachmentId —— 路径/字节均由 Main 处理。
// 失败时用现有 toast 提示；不新增 Toast 体系。
export async function copyAttachmentImage(attachmentId: string): Promise<void> {
  try {
    const res = await window.openchat.attachments.copyImage(attachmentId)
    if (!res || !res.copied) {
      useUiStore.getState().showToast('复制图片失败')
    }
  } catch {
    useUiStore.getState().showToast('复制图片失败')
  }
}
