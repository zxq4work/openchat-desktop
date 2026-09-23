import { useConversationStore } from '../stores/conversationStore'

// 统一的会话打开逻辑，供 ConversationItem / 全局搜索结果 / 命中导航复用。
// 点击当前已 active 的会话为 no-op：避免流式期间用 DB 中途落盘内容覆盖 live 渲染基线。
// 只读：不修改会话 updatedAt / 排序。
export async function selectConversationById(id: string): Promise<boolean> {
  const store = useConversationStore.getState()
  if (store.activeConversationId === id) {
    return true
  }
  const data = await window.openchat.conversations.get(id)
  if (!data) return false
  // 原子写入：一次 set 同时更新 id/conversation/messages/segments，消除中间态
  useConversationStore.getState().activateConversation(
    id, data.conversation, data.messages, data.segments
  )
  return true
}
