/** Where the person goes once a chat is deleted, archived or left: nowhere unless it was the one open. */
export type ChatRemovalNavigation = {
  /** The chat view, or the room view, shows the removed chat: leave it. */
  leaveChatView: boolean;
  /** The agent page points at the removed chat: drop it, so the page opens another or starts one. */
  clearAgentChat: boolean;
};

export function chatRemovalNavigation(
  roomId: string,
  nav: { currentViewId: string; chatRoomId?: string; roomRoomId?: string; agentRoomId?: string }
): ChatRemovalNavigation {
  return {
    leaveChatView:
      (nav.currentViewId === 'chat' && nav.chatRoomId === roomId) ||
      (nav.currentViewId === 'room' && nav.roomRoomId === roomId),
    clearAgentChat: nav.agentRoomId === roomId,
  };
}
