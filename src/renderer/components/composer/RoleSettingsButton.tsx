import React from 'react'
import { useUiStore } from '../../stores/uiStore'

export function RoleSettingsButton() {
  const setRoleDialogOpen = useUiStore((s) => s.setRoleDialogOpen)

  return (
    <button className="role-settings-btn" onClick={() => setRoleDialogOpen(true)} title="角色设定">
      ⚙ 角色设定
    </button>
  )
}