import React, { useState, useEffect } from 'react'
import type { Conversation } from '../../../shared/types/conversation'
import { useConversationStore } from '../../stores/conversationStore'
import { useUiStore } from '../../stores/uiStore'
import { useDialogStack } from '../../hooks/useDialogStack'

export function ConversationSettingsDialog() {
  const targetId = useUiStore((s) => s.conversationSettingsTargetId)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const setSummaries = useConversationStore((s) => s.setSummaries)
  const setConversationSettingsOpen = useUiStore((s) => s.setConversationSettingsOpen)

  useDialogStack(() => setConversationSettingsOpen(false))

  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [title, setTitle] = useState('')
  const [role, setRole] = useState('')
  const [useModelInstructions, setUseModelInstructions] = useState(true)

  useEffect(() => {
    if (!targetId) return
    // 如果是当前激活的会话，数据已在 store 中，无需查询
    const activeConv = useConversationStore.getState().activeConversation
    if (activeConv && activeConv.id === targetId) {
      setConversation(activeConv)
      setTitle(activeConv.title ?? '')
      setRole(activeConv.systemPrompt ?? '')
      setUseModelInstructions(activeConv.useModelInstructions ?? true)
      return
    }
    window.openchat.conversations.get(targetId).then((data) => {
      if (data) {
        setConversation(data.conversation)
        setTitle(data.conversation.title ?? '')
        setRole(data.conversation.systemPrompt ?? '')
        setUseModelInstructions(data.conversation.useModelInstructions ?? true)
      }
    })
  }, [targetId])

  const handleSave = async () => {
    if (!conversation) return

    const trimmedTitle = title.trim()
    if (trimmedTitle && trimmedTitle !== conversation.title) {
      await window.openchat.conversations.rename(conversation.id, trimmedTitle)
    }
    if (role !== conversation.systemPrompt) {
      await window.openchat.conversations.updateRole(conversation.id, role)
    }
    if (useModelInstructions !== conversation.useModelInstructions) {
      await window.openchat.conversations.updateUseModelInstructions(conversation.id, useModelInstructions)
    }

    // 如果是当前激活的会话，更新 store 中的 conversation 数据
    if (activeConversationId === conversation.id) {
      const data = await window.openchat.conversations.get(conversation.id)
      if (data) {
        setActiveConversation(data.conversation)
        useConversationStore.getState().setActiveSegments(data.segments)
      }
    }
    const list = await window.openchat.conversations.list()
    setSummaries(list)
    setConversationSettingsOpen(false)
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>会话设置</h3>

        <div className="settings-section">
          <h4>会话名称</h4>
          <input
            className="conversation-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="会话名称"
          />
        </div>

        <div className="settings-section">
          <h4>角色设定（系统提示）</h4>
          <textarea
            className="role-textarea"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="例如：你是一名资深 Java 架构师……"
            rows={6}
          />
        </div>

        <div className="settings-section">
          <label className="settings-switch-label">
            <span>使用模型自带提示词</span>
            <div
              className={`settings-switch ${useModelInstructions ? 'settings-switch-on' : ''}`}
              onClick={() => setUseModelInstructions(!useModelInstructions)}
              role="switch"
              aria-checked={useModelInstructions}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setUseModelInstructions(!useModelInstructions)
                }
              }}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>
          <p className="settings-switch-hint">
            Codex 模型自带任务指令模板，启用后会在角色设定之前注入模型的默认行为指令。
          </p>
        </div>

        <div className="dialog-actions">
          <button className="btn-cancel" onClick={() => setConversationSettingsOpen(false)}>取消</button>
          <button className="btn-save" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}