import React, { useState } from 'react'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'

export function ConversationRoleDialog() {
  const conversation = useConversationStore((s) => s.activeConversation)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const setRoleDialogOpen = useUiStore((s) => s.setRoleDialogOpen)
  const [prompt, setPrompt] = useState(conversation?.systemPrompt ?? '')

  const handleSave = async () => {
    if (!conversation) return
    await window.openchat.conversations.updateRole(conversation.id, prompt)

    // 刷新数据
    const data = await window.openchat.conversations.get(conversation.id)
    if (data) {
      useConversationStore.getState().setActiveConversation(data.conversation)
      useConversationStore.getState().setActiveSegments(data.segments)
    }
    setRoleDialogOpen(false)
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog role-dialog">
        <h3>角色设定</h3>
        <p className="dialog-subtitle">系统提示</p>
        <textarea
          className="role-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例如：你是一名资深 Java 架构师……"
          rows={8}
        />
        <div className="dialog-actions">
          <button className="btn-cancel" onClick={() => setRoleDialogOpen(false)}>取消</button>
          <button className="btn-save" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}