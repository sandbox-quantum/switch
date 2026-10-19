/** Where the person goes once a chat is deleted or archived: nowhere unless it was the one open. */
export type ChatRemovalNavigation = {
  /** The chat view shows the removed chat: leave it. */
  leaveChatView: boolean;
  /** The agent page points at the removed chat: drop it, so the page opens another or starts one. */
  clearAgentChat: boolean;
};

export function chatRemovalNavigation(
  roomId: string,
  nav: { currentViewId: string; chatRoomId?: string; agentRoomId?: string }
): ChatRemovalNavigation {
  return {
    leaveChatView: nav.currentViewId === 'chat' && nav.chatRoomId === roomId,
    clearAgentChat: nav.agentRoomId === roomId,
  };
}
