import { createContext, type ComponentType, type ReactNode, useContext } from 'react';
import type { ChatAgent, ChatAttachment, ChatCommand, ChatSummary } from './contracts/chats';
import type { AgentActivities } from './stores/chat-activity-store';
import type { ChatsStore } from './stores/chats-store';

export type ChatPerson = { userId: string; name: string; email: string | null };

export type ChatToast = { title: string; description?: string; variant?: 'destructive' };

export type AgentAvatarProps = {
  /**
   * The agent drawn, when known: only the person's own switch-buddy wears
   * switch-buddy's picture. Null for an agent the app draws before it exists,
   * whose picture the app chose itself.
   */
  agentId?: string | null;
  name: string;
  iconUrl: string | null;
  serverId: string;
  size: number;
};

/**
 * What the app showing a chat provides: its chats and activity stores, wired
 * to however it reaches Switch, and the pieces of its own UI a chat draws
 * (avatars, messaging-app icons, toasts, links). Switch Console and the web
 * dashboard each make one and put it above every chat they draw.
 */
export type ChatHost = {
  chats: ChatsStore;
  activities: AgentActivities;
  /** The agent of a direct chat that has no room yet, made on its first message. */
  unsavedChat: (roomId: string) => { agentId: string } | undefined;
  /** A message was sent: the host may name a new chat from it. */
  sent: (serverId: string, roomId: string, body: string) => void;
  /** Who a chat's drafts belong to, kept apart per account and workspace. */
  draftOwner: (serverId: string) => { userId: string | null; workspaceId: string | null };
  commands: (serverId: string, roomId: string) => Promise<ChatCommand[]>;
  /** An attachment's bytes, base64, through the chat's media route. */
  media: (
    serverId: string,
    roomId: string,
    uri: string
  ) => Promise<{ mimeType: string; data: string }>;
  /**
   * Saves an attachment to the person's computer. Anyone in a room can name a
   * file, so the host saves it under `attachmentFilename` and never renders it.
   */
  saveAttachment: (serverId: string, roomId: string, attachment: ChatAttachment) => Promise<void>;
  /**
   * Follows any link in a message, whatever its scheme; the chat never
   * navigates the page itself. The host decides which links it opens and how.
   */
  openLink: (href: string) => void;
  /**
   * Whether `agentId` is the person's own switch-buddy on this server. Only it
   * goes by switch-buddy's name and picture; any other agent whose name reads
   * as switch-buddy's is shown by its unique name.
   */
  isOwnBuddy: (serverId: string, agentId: string) => boolean;
  /** Whether a dialog is open over the chat, so typing should not go to its composer. */
  isModalOpen: () => boolean;
  toast: (toast: ChatToast) => void;
  bridgePlatformLabel: (bridgeType: string | null) => string;
  hasBridgeIcon: (platform: string) => boolean;
  /** The chat's people: `members` are in it, `known` adds the rest of the workspace. */
  useChatPeople: (
    serverId: string,
    chat: ChatSummary | undefined
  ) => { members: ChatPerson[]; known: ChatPerson[] };
  /** Whether the server has group chats: mentioning people and several agents. */
  useGroupChats: (serverId: string) => boolean;
  useDarkMode: () => boolean;
  /** An agent's avatar colour, or null until it is known or when there is none. */
  useAgentAccent: (agent: ChatAgent | null, serverId: string) => string | null;
  AgentAvatar: ComponentType<AgentAvatarProps>;
  BridgeIcon: ComponentType<{ bridgeType: string; size: number }>;
  /** Ask the user to confirm an action: title, description and confirm button label. Returns whether they confirmed. */
  confirm: (opts: { title: string; description: string; confirmLabel: string }) => Promise<boolean>;
  /** Prompt the user to rename a chat. Returns the new name if confirmed, null if cancelled. */
  rename: (chat: { roomId: string; currentName: string }) => Promise<string | null>;
  /** Reconnect the chat feed after it went offline. */
  reconnectFeed: (serverId: string) => Promise<void>;
  /** Restart an agent's session: only for local sessions the app can reach. */
  restartSession?: (sessionId: string) => Promise<void>;
  /** Navigate after a chat is removed: home, or to an agent's page. */
  navigate: (target: 'home' | { agent: string; chat?: string; room?: string }) => void;
  /** Whether the given room is currently the open chat. */
  isOpenChat: (roomId: string) => boolean;
  /** Leave the currently open chat if it matches the given roomId. */
  leaveOpenChat: (roomId: string) => void;
};

const ChatHostContext = createContext<ChatHost | null>(null);

export function ChatHostProvider({ host, children }: { host: ChatHost; children: ReactNode }) {
  return <ChatHostContext.Provider value={host}>{children}</ChatHostContext.Provider>;
}

export function useChatHost(): ChatHost {
  const host = useContext(ChatHostContext);
  if (!host) throw new Error('A chat was drawn outside a ChatHostProvider.');
  return host;
}

/** The host, or null where none is provided yet (an app still loading it, say). */
export function useOptionalChatHost(): ChatHost | null {
  return useContext(ChatHostContext);
}

/** The host's avatar for an agent. */
export function AgentAvatar(props: AgentAvatarProps) {
  const { AgentAvatar: HostAvatar } = useChatHost();
  return <HostAvatar {...props} />;
}

/** The host's icon for a messaging app. */
export function BridgeIcon(props: { bridgeType: string; size: number }) {
  const { BridgeIcon: HostIcon } = useChatHost();
  return <HostIcon {...props} />;
}

/** The name of the messaging app a message came from. */
export function BridgePlatformLabel({ bridgeType }: { bridgeType: string | null }) {
  return <>{useChatHost().bridgePlatformLabel(bridgeType)}</>;
}

export type AgentIconChoice = {
  url: string;
  label: string;
};

export type AgentHost = {
  /** Look up a provider by id: its name and whether it supports auto mode. */
  provider: (id: string) => { name: string; supportsAutoMode: boolean } | null;
  /** Icons the agent card can offer: generated avatars, the provider's default, uploaded. */
  iconChoices: (agent: { name: string; provider: string }) => AgentIconChoice[];
  toast: (message: { title: string; description?: string; variant?: 'destructive' }) => void;
  confirm: (message: { title: string; description: string; action: string }) => Promise<boolean>;
  /** Navigate to a page by its path; the agent never routes itself. */
  navigate: (path: string) => void;
};

const AgentHostContext = createContext<AgentHost | null>(null);

export function AgentHostProvider({ host, children }: { host: AgentHost; children: ReactNode }) {
  return <AgentHostContext.Provider value={host}>{children}</AgentHostContext.Provider>;
}

export function useAgentHost(): AgentHost {
  const host = useContext(AgentHostContext);
  if (!host) throw new Error('Agent UI was drawn outside an AgentHostProvider.');
  return host;
}

export function useOptionalAgentHost(): AgentHost | null {
  return useContext(AgentHostContext);
}
