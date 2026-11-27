import "@switch-console/chat-ui/theme.css";

import { Alert, Snackbar, useColorScheme } from "@mui/material";
import {
  type AgentAvatarProps,
  type ChatHost,
  type ChatToast,
  ChatHostProvider,
} from "@switch-console/chat-ui/host";
import type { BridgeIcons } from "@switch-console/chat-ui/components/messaging-app-selector";
import type { ParticipantMarks } from "@switch-console/chat-ui/components/participant-picker";
import { pickAccent } from "@switch-console/chat-ui/model/agent-accent";
import { resolveAgentAvatarSrc } from "@switch-console/chat-ui/model/agent-avatar";
import { attachmentFilename } from "@switch-console/chat-ui/model/attachment-filename";
import { findBuddy } from "@switch-console/chat-ui/model/buddy";
import { configureFailures } from "@switch-console/chat-ui/model/failures";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import AgentPicture from "../../components/AgentPicture";
import { useAuth } from "../../data/AuthContext";
import { fetchAvatarSettings } from "../../data/api";
import { agentsClient } from "../../data/useManagedAgent";
import { platformLabel } from "../../theme/format";
import { useAppLogos } from "../messaging-apps/appLogos";
import { webLinkTarget } from "./consoleLinkOnWeb";
import { webChatsClient, webFailures } from "./webChatClient";
import { type WebChats, createWebChats } from "./webChats";
import { ConfirmDialog } from "./ConfirmDialog";
import { RenameChatDialog } from "./RenameChatDialog";

configureFailures(webFailures);

const WebChatsContext = createContext<WebChats | null>(null);

/** The dashboard's chats, for the pages that start direct chats; null outside the host. */
export function useWebChats(): WebChats | null {
  return useContext(WebChatsContext);
}

/** Whether the server lets the dashboard draw generated avatars; null until it has said. */
function useThirdPartyAvatars(): boolean | null {
  const settings = useQuery({
    queryKey: ["avatar-settings"],
    queryFn: fetchAvatarSettings,
    staleTime: Infinity,
  });
  return settings.data?.third_party_avatars_enabled ?? null;
}

function AgentAvatar({ name, iconUrl, size }: Pick<AgentAvatarProps, "name" | "iconUrl" | "size">) {
  return <AgentPicture name={name} iconUrl={iconUrl} size={size} thirdParty={useThirdPartyAvatars()} />;
}

/** Agents as the dashboard draws them, for the shared participant picker. */
export const WEB_PARTICIPANT_MARKS: ParticipantMarks = { AgentAvatar, useAgentAccent };

/**
 * Messaging apps' icons as the dashboard draws them: each platform's logo as
 * Switch serves it, so a platform added later is not left without one.
 */
export function useWebBridgeIcons(): BridgeIcons {
  const logos = useAppLogos();
  return useMemo(
    () => ({
      BridgeIcon: ({ bridgeType, size, className }) => {
        const src = logos.get(bridgeType);
        return src ? <img src={src} alt="" width={size} height={size} className={className} /> : null;
      },
      hasBridgeIcon: (platform) => logos.has(platform),
    }),
    [logos],
  );
}

/**
 * Saves a room attachment as a download, under its name as the chat shows it
 * (`attachmentFilename`): anyone in a room can name a file.
 */
async function saveAttachmentOf(roomId: string, uri: string, filename: string): Promise<void> {
  const { mimeType, bytes } = await webChatsClient.fetchChatMedia(roomId, uri);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = attachmentFilename(filename);
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
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

const SAMPLE_PX = 24;
const accents = new Map<string, Promise<string | null>>();
const settled = new Map<string, string | null>();

function sampleAccent(src: string): Promise<string | null> {
  let pending = accents.get(src);
  if (!pending) {
    pending = new Promise<string | null>((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = SAMPLE_PX;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0, SAMPLE_PX, SAMPLE_PX);
          const rgb = pickAccent(context.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data);
          resolve(rgb ? `rgb(${rgb.join(" ")})` : null);
        } catch {
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = src;
    }).then((accent) => {
      settled.set(src, accent);
      return accent;
    });
    accents.set(src, pending);
  }
  return pending;
}

function useAgentAccent(
  agent: { name: string; iconUrl: string | null } | null,
  _serverId: string | null
): string | null {
  const thirdParty = useThirdPartyAvatars();
  const src = agent ? resolveAgentAvatarSrc(agent.iconUrl, agent.name, thirdParty) : null;
  const [loaded, setLoaded] = useState<{ src: string; accent: string | null } | null>(null);
  useEffect(() => {
    if (!src || settled.has(src)) return;
    let live = true;
    void sampleAccent(src).then((accent) => {
      if (live) setLoaded({ src, accent });
    });
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return null;
  return settled.get(src) ?? (loaded?.src === src ? loaded.accent : null);
}

/**
 * Chats as the dashboard draws them: Switch's chat UI, shared with Console,
 * reaching Switch with the browser's own sign-in. Everything under it may
 * draw a chat. The feeds open only when a chat surface is mounted.
 */
type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
};

type RenameRequest = {
  roomId: string;
  currentName: string;
  resolve: (newName: string | null) => void;
};

export default function WebChatHost({ children }: { children: ReactNode }) {
  const { user, session } = useAuth();
  const userId = user?.id ?? null;
  const tenantId = session?.tenant?.id ?? null;
  // Group chats are always on.
  const groupChats = true;
  const navigate = useNavigate();
  const location = useLocation();
  const [queryClient] = useState(() => new QueryClient());
  const [toast, setToast] = useState<ChatToast | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);
  const bridgeIcons = useWebBridgeIcons();
  // The person's own switch-buddy in this workspace: only it goes by switch-buddy's name and picture.
  const [ownBuddyId, setOwnBuddyId] = useState<string | null>(null);
  useEffect(() => {
    if (!tenantId) return;
    let current = true;
    agentsClient
      .listManagedAgents()
      .then((agents) => {
        if (current) setOwnBuddyId(findBuddy(agents)?.agent_id ?? null);
      })
      .catch((error: unknown) => {
        console.warn("Could not read your managed agents to find your switch-buddy", error);
      });
    return () => {
      current = false;
    };
  }, [tenantId]);

  const web = useMemo(
    () => (userId && tenantId ? createWebChats({ userId, tenantId }) : null),
    [userId, tenantId],
  );

  const host = useMemo<ChatHost | null>(
    () =>
      web && {
        chats: web.chats,
        activities: web.activities,
        unsavedChat: (roomId) => web.directChats.unsavedChat(roomId),
        sent: (server, roomId, body) => void web.titler.sent(server, roomId, body),
        draftOwner: () => ({ userId, workspaceId: tenantId }),
        commands: (_serverId, roomId) => webChatsClient.listChatCommands(roomId),
        media: (_serverId, roomId, uri) => mediaOf(roomId, uri),
        saveAttachment: (_serverId, roomId, attachment) =>
          saveAttachmentOf(roomId, attachment.uri, attachment.filename),
        isOwnBuddy: (_serverId, agentId) => ownBuddyId !== null && agentId === ownBuddyId,
        openLink: (href) => {
          // A link to a Console page opens the page that does its job here, where there is one.
          const target = webLinkTarget(href);
          if (target.kind === "external") window.open(target.href, "_blank", "noopener,noreferrer");
          else if (target.kind === "page") navigate(target.path);
          else if (target.kind === "console-only")
            setToast({
              title: "That page is in Switch Console",
              description: "It has no page in the web dashboard yet.",
            });
        },
        isModalOpen: () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
        toast: setToast,
        bridgePlatformLabel: (bridgeType) => (bridgeType ? platformLabel(bridgeType) : "messaging app"),
        hasBridgeIcon: bridgeIcons.hasBridgeIcon,
        useChatPeople,
        useGroupChats: () => groupChats,
        useDarkMode,
        useAgentAccent,
        AgentAvatar,
        BridgeIcon: bridgeIcons.BridgeIcon,
        confirm: (opts) =>
          new Promise<boolean>((resolve) => {
            setConfirmRequest({ ...opts, resolve });
          }),
        rename: ({ roomId, currentName }) =>
          new Promise<string | null>((resolve) => {
            setRenameRequest({ roomId, currentName, resolve });
          }),
        reconnectFeed: (serverId) => web.chats.connect(serverId),
        navigate: (target) => {
          if (target === "home") {
            navigate("/chats");
          } else {
            navigate(`/chats/agents/${target.agent}`);
          }
        },
        isOpenChat: (roomId) => {
          const params = new URLSearchParams(location.search);
          return params.get("chat") === roomId || params.get("room") === roomId || location.pathname.includes(`/chats/rooms/${roomId}`);
        },
        leaveOpenChat: (roomId) => {
          const params = new URLSearchParams(location.search);
          const chatParam = params.get("chat");
          const roomParam = params.get("room");
          if (chatParam === roomId || roomParam === roomId) {
            const match = location.pathname.match(/\/chats\/agents\/([^/?]+)/);
            if (match) {
              navigate(`/chats/agents/${match[1]}`);
            } else {
              navigate("/chats");
            }
          } else if (location.pathname.includes(`/chats/rooms/${roomId}`)) {
            navigate("/chats");
          }
        },
      },
    [web, userId, tenantId, groupChats, navigate, location, setConfirmRequest, setRenameRequest, bridgeIcons, ownBuddyId],
  );

  if (!host || !web) return <>{children}</>;
  return (
    <QueryClientProvider client={queryClient}>
      <WebChatsContext.Provider value={web}>
        <ChatHostProvider host={host}>{children}</ChatHostProvider>
      </WebChatsContext.Provider>
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
      {confirmRequest && (
        <ConfirmDialog
          open
          title={confirmRequest.title}
          description={confirmRequest.description}
          confirmLabel={confirmRequest.confirmLabel}
          onConfirm={() => {
            confirmRequest.resolve(true);
            setConfirmRequest(null);
          }}
          onCancel={() => {
            confirmRequest.resolve(false);
            setConfirmRequest(null);
          }}
        />
      )}
      {renameRequest && (
        <RenameChatDialog
          open
          currentName={renameRequest.currentName}
          onConfirm={(newName) => {
            renameRequest.resolve(newName);
            setRenameRequest(null);
          }}
          onCancel={() => {
            renameRequest.resolve(null);
            setRenameRequest(null);
          }}
        />
      )}
    </QueryClientProvider>
  );
}
