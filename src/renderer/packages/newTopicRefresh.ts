// Cmd/Ctrl+R「新话题」异步刷新的一致性判定。
//
// onNewTopic 需要两次异步 IPC（newTopic → get）才能拿到刷新后的会话数据。
// 期间用户可能已切换到别的会话；若仍用旧会话数据写回 activeConversation/
// activeMessages/activeSegments，会造成 activeConversationId（新会话）与展示内容
// （旧会话）错位，并让随后的「重置后贴底」请求作用到错误的会话。
//
// 判定：只有请求发起时的会话 id 仍是当前会话，刷新与贴底才生效。
export function shouldApplyNewTopicRefresh(
  activeConversationId: string | null,
  requestedConversationId: string,
): boolean {
  return activeConversationId === requestedConversationId
}
