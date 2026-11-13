import { createContext, type ComponentType, type ReactNode, useContext } from 'react';
import type { ChatAgent, ChatCommand, ChatSummary } from './contracts/chats';
import type { AgentActivities } from './stores/chat-activity-store';
import type { ChatsStore } from './stores/chats-store';

export type ChatPerson = { userId: string; name: string; email: string | null };

export type ChatToast = { title: string; description?: string; variant?: 'destructive' };

export type AgentAvatarProps = {
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
  /** Opens a link from a message; the chat never navigates the page itself. */
  openLink: (href: string) => void;
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
