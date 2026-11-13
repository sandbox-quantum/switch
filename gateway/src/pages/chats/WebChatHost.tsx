import "./chat.css";

import { Alert, Snackbar, useColorScheme } from "@mui/material";
import {
  type AgentAvatarProps,
  type ChatHost,
  type ChatToast,
  ChatHostProvider,
} from "@switch-console/chat-ui/host";
import { agentInitials, resolveAgentAvatarSrc } from "@switch-console/chat-ui/model/agent-avatar";
import { configureFailures } from "@switch-console/chat-ui/model/failures";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import discordIcon from "../../assets/bridges/discord.svg";
import slackIcon from "../../assets/bridges/slack.svg";
import telegramIcon from "../../assets/bridges/telegram.svg";
import { useAuth } from "../../data/AuthContext";
import { GROUP_CHATS } from "../../data/featureFlags";
import { webChatsClient, webFailures } from "./webChatClient";
import { createWebChats } from "./webChats";

configureFailures(webFailures);

const BRIDGE_ICONS: Record<string, string> = {
  discord: discordIcon,
  slack: slackIcon,
  telegram: telegramIcon,
};

const BRIDGE_LABELS: Record<string, string> = {
  slack: "Slack",
  mattermost: "Mattermost",
  teams: "Microsoft Teams",
  discord: "Discord",
  telegram: "Telegram",
};

/**
 * An agent's picture, or its initials. Only an icon its owner chose on a
 * host of their own is loaded: a generated avatar would send the agent's name
 * to a third party, which the dashboard does not do.
 */
function AgentAvatar({ name, iconUrl, size }: AgentAvatarProps) {
  const src = resolveAgentAvatarSrc(iconUrl, name, false);
  const [failed, setFailed] = useState<string | null>(null);
  const shape = "inline-flex shrink-0 items-center justify-center rounded-full";
  if (src === null || failed === src)
    return (
      <span
        className={`${shape} bg-background-2 font-medium text-foreground-muted`}
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) }}
        title={name}
      >
        {agentInitials(name)}
      </span>
    );
  return (
    <span className={shape} style={{ width: size, height: size }}>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="size-full rounded-full object-cover"
        onError={() => setFailed(src)}
      />
    </span>
  );
}

function BridgeIcon({ bridgeType, size }: { bridgeType: string; size: number }) {
  const src = BRIDGE_ICONS[bridgeType];
  return src ? <img src={src} alt="" width={size} height={size} /> : null;
}

async function mediaOf(roomId: string, uri: string): Promise<{ mimeType: string; data: string }> {
  const { mimeType, bytes } = await webChatsClient.fetchChatMedia(roomId, uri);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { mimeType, data: btoa(binary) };
}

function useChatPeople(_serverId: string, chat: Parameters<ChatHost["useChatPeople"]>[1]) {
  const { session } = useAuth();
  const tenantId = session?.tenant?.id ?? null;
  const members = useQuery({
    queryKey: ["chat-members", chat?.roomId ?? null, chat?.memberUserIds.join(",") ?? ""],
    queryFn: () => webChatsClient.listChatMembers(chat!.roomId),
    enabled: chat !== undefined,
  });
  const roster = useQuery({
    queryKey: ["workspace-members", tenantId],
    queryFn: () => webChatsClient.listWorkspaceMembers(tenantId!),
    enabled: tenantId !== null,
  });
  const emails = new Map((roster.data ?? []).map((person) => [person.userId, person.email]));
  const inChat = (members.data ?? []).map((member) => ({
    userId: member.userId,
    name: member.name,
    email: emails.get(member.userId) ?? null,
  }));
  const ids = new Set(inChat.map((member) => member.userId));
  return {
    members: inChat,
    known: [...inChat, ...(roster.data ?? []).filter((person) => !ids.has(person.userId))],
  };
}

function useDarkMode(): boolean {
  const { mode, systemMode } = useColorScheme();
  return (mode === "system" ? systemMode : mode) === "dark";
}

/**
 * Chats as the dashboard draws them: Switch's chat UI, shared with Console,
 * reaching Switch with the browser's own sign-in. Everything under it may
 * draw a chat. The feeds open once for the person and workspace, and close
 * and start again when either changes.
 */
export default function WebChatHost({ children }: { children: ReactNode }) {
  const { user, session, capabilities } = useAuth();
  const userId = user?.id ?? null;
  const tenantId = session?.tenant?.id ?? null;
  const groupChats = capabilities.features[GROUP_CHATS];
  const [queryClient] = useState(() => new QueryClient());
  const [toast, setToast] = useState<ChatToast | null>(null);

  const web = useMemo(
    () => (userId && tenantId ? createWebChats({ userId, tenantId }) : null),
    [userId, tenantId],
  );
  useEffect(() => {
    if (!web) return;
    web.start();
    return () => web.stop();
  }, [web]);

  const host = useMemo<ChatHost | null>(
    () =>
      web && {
        chats: web.chats,
        activities: web.activities,
        unsavedChat: () => undefined,
        sent: () => {},
        draftOwner: () => ({ userId, workspaceId: tenantId }),
        commands: (_serverId, roomId) => webChatsClient.listChatCommands(roomId),
        media: (_serverId, roomId, uri) => mediaOf(roomId, uri),
        openLink: (href) => {
          // A link to a Console page has no meaning on the web; the rest open in a new tab.
          if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
        },
        isModalOpen: () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
        toast: setToast,
        bridgePlatformLabel: (bridgeType) =>
          bridgeType ? (BRIDGE_LABELS[bridgeType] ?? bridgeType) : "messaging app",
        hasBridgeIcon: (platform) => platform in BRIDGE_ICONS,
        useChatPeople,
        useGroupChats: () => groupChats,
        useDarkMode,
        useAgentAccent: () => null,
        AgentAvatar,
        BridgeIcon,
      },
    [web, userId, tenantId, groupChats],
  );

  if (!host) return <>{children}</>;
  return (
    <QueryClientProvider client={queryClient}>
      <ChatHostProvider host={host}>{children}</ChatHostProvider>
      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={toast?.variant === "destructive" ? "error" : "info"}
          onClose={() => setToast(null)}
        >
          {toast?.title}
          {toast?.description ? ` ${toast.description}` : ""}
        </Alert>
      </Snackbar>
    </QueryClientProvider>
  );
}
