export type AutoStartChatInput = {
  /** The chats store holds this agent's server and has listed its chats. */
  listed: boolean;
  listFailed: boolean;
  hasDirectChats: boolean;
  /** A chat or the settings is selected in the page's params. */
  selected: boolean;
  /** A start was already tried for this agent on this page visit. */
  tried: boolean;
};

/** Whether an agent's page starts a direct chat by itself: once, and only when it has none. */
export function shouldAutoStartChat(input: AutoStartChatInput): boolean {
  return (
    input.listed && !input.listFailed && !input.hasDirectChats && !input.selected && !input.tried
  );
}
