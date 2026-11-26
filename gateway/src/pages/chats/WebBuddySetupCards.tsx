import {
  type BuddySetupServices,
  BuddySetupCards,
} from "@switch-console/chat-ui/components/buddy-setup-cards";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { useChatHost } from "@switch-console/chat-ui/host";
import {
  type BuddyRefusal,
  REFUSAL_CODES,
  type RemoteBridge,
  buddyRestartedHandoffRequestId,
  buddyHandoffRequestId,
} from "@switch-console/chat-ui/model/buddy-setup-step";
import { buddyChannelOpener } from "@switch-console/chat-ui/model/buddy-welcome-message";
import { useQuery } from "@tanstack/react-query";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../data/AuthContext";
import { type BridgeDetail, fetchBridges, fetchMyIdentities, fetchRoom } from "../../data/api";
import RegisterMessagingAppDialog from "../collaborations/RegisterMessagingAppDialog";
import LinkAccountDialog from "../messaging-apps/LinkAccountDialog";
import { ChatRequestError, webChatsClient } from "./webChatClient";

/** What the person says in the Welcome chat when they choose to stay in the dashboard's chat. */
export const WEB_BUDDY_STAY_MESSAGE = "I’ll stay here in Switch for now.";

function refusalOf(cause: unknown): BuddyRefusal | null {
  if (!(cause instanceof ChatRequestError) || !cause.apiCode) return null;
  if (!REFUSAL_CODES.includes(cause.apiCode)) return null;
  return { code: cause.apiCode as BuddyRefusal["code"], message: cause.message };
}

function failureText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Console's chat-app tiles under switch-buddy's Welcome chat, on the web:
 * connecting an app and linking an account open the dashboard's own dialogs
 * in place, and the private channel is made with the same chat call Console
 * makes.
 */
export const WebBuddySetupCards = observer(function WebBuddySetupCards({
  serverId,
  roomId,
  agentId,
  agentName,
}: {
  serverId: string;
  roomId: string;
  agentId: string;
  agentName: string;
}) {
  const { user, session } = useAuth();
  const host = useChatHost();
  const navigate = useNavigate();
  const [connecting, setConnecting] = useState<{ type: string; onClosed: () => void } | null>(null);
  const [linking, setLinking] = useState<BridgeDetail | null>(null);
  const scope = session?.tenant?.id ?? "none";
  const firstName = user?.name?.split(/\s+/)[0] || null;

  const bridgesQuery = useQuery({
    queryKey: ["buddy-setup-bridges", scope],
    queryFn: async () => (await fetchBridges()) ?? [],
  });
  const identitiesQuery = useQuery({
    queryKey: ["buddy-setup-identities", scope],
    queryFn: fetchMyIdentities,
  });

  const timeline = host.chats.timelines.get(serverId, roomId);
  const stayed =
    timeline.messages.some(
      (message) => message.sender.kind === "human" && message.body === WEB_BUDDY_STAY_MESSAGE,
    ) || timeline.pending.some((send) => send.body === WEB_BUDDY_STAY_MESSAGE);

  const handOff = (bridge: RemoteBridge, requestId: string, resumeOnly: boolean) =>
    webChatsClient
      .createChat({
        agentIds: [agentId],
        name: null,
        bridgeId: bridge.id,
        requestId,
        greeting: buddyChannelOpener(firstName, host.bridgePlatformLabel(bridge.type)),
        resumeOnly,
      })
      .then((chat: ChatSummary) => {
        host.chats.add(serverId, chat);
        return chat;
      });

  const resumeOne = async (bridge: RemoteBridge, requestId: string) => {
    try {
      return await handOff(bridge, requestId, true);
    } catch (cause) {
      if (cause instanceof ChatRequestError && cause.apiCode === "NO_SUCH_OPERATION") return null;
      throw cause;
    }
  };

  const services: BuddySetupServices = {
    scope,
    useBridges: () => ({
      data:
        bridgesQuery.data?.map((bridge) => ({
          id: bridge.bridge_id,
          type: bridge.bridge_type,
          displayName: bridge.display_name,
          status: bridge.status,
          directorySearchSupported: bridge.directory_search_supported,
        })) ?? null,
      isError: bridgesQuery.isError,
      refetch: bridgesQuery.refetch,
    }),
    useIdentities: () => ({
      identities:
        identitiesQuery.data?.map((identity) => ({
          bridgeId: identity.bridge_id,
          externalUserId: identity.external_user_id,
        })) ?? null,
      error: identitiesQuery.error,
      refresh: () => void identitiesQuery.refetch(),
    }),
    // A first hand-off made for an account no longer linked gives way to the one
    // started again for the account linked now, as Console's does.
    resume: async (bridge, accountIds) => {
      try {
        return await resumeOne(bridge, buddyHandoffRequestId(agentId, bridge.id));
      } catch (cause) {
        const only = accountIds.length === 1 ? accountIds[0] : undefined;
        if (refusalOf(cause)?.code !== "LINKED_ACCOUNT_CHANGED" || only === undefined) throw cause;
        const restarted = await resumeOne(
          bridge,
          buddyRestartedHandoffRequestId(agentId, bridge.id, only),
        );
        if (restarted === null) throw cause;
        return restarted;
      }
    },
    handOff: (bridge, requestId) => handOff(bridge, requestId, false),
    refusalOf,
    failureText,
    roomChannel: async (id) => {
      const room = await fetchRoom(id);
      return {
        channelName: room?.linked_channel_name ?? null,
        channelUrl: room?.external_channel_url ?? null,
        createdAt: room?.created_at ?? null,
      };
    },
    connect: (platform, onClosed) => setConnecting({ type: platform, onClosed }),
    linkAccount: (bridge) =>
      setLinking(bridgesQuery.data?.find((each) => each.bridge_id === bridge.id) ?? null),
    manageLinkedAccounts: () => navigate("/settings/messaging-apps"),
    openChannel: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    stay: {
      icon: (
        <>
          <img src="/switch_logo_dark.svg" alt="" width={28} height={28} className="dark:hidden" />
          <img
            src="/switch_logo_light.svg"
            alt=""
            width={28}
            height={28}
            className="hidden dark:block"
          />
        </>
      ),
      name: "Switch",
      message: WEB_BUDDY_STAY_MESSAGE,
    },
    stayed,
    onStay: () =>
      timeline.send({
        body: WEB_BUDDY_STAY_MESSAGE,
        threadRootId: null,
        mentionAgentIds: [],
        mentionUserIds: [],
        mentionSpans: [],
        files: [],
        requestId: null,
      }),
    bridgeIcon: (bridgeType, size) => <host.BridgeIcon bridgeType={bridgeType} size={size} />,
    inviteCommand: (bridge, name) => (
      <code className="rounded bg-background px-2 py-1 font-mono text-sm select-all">
        {bridge.type === "telegram" ? "/invite_agent" : "!invite-agent"} @{name}
      </code>
    ),
    // The step-by-step list for Telegram is Console's; here it is the plain link card.
    checklist: () => null,
    // Whether they are talking to the buddy there is read by Console alone for now.
    useTalking: () => ({ inGroup: false, inChannel: false }),
    info: null,
    createdSince: () => null,
  };

  return (
    <>
      <BuddySetupCards services={services} agentId={agentId} agentName={agentName} />
      <RegisterMessagingAppDialog
        open={connecting !== null}
        initialType={connecting?.type ?? ""}
        onClose={() => {
          connecting?.onClosed();
          setConnecting(null);
        }}
        onSuccess={() => {
          connecting?.onClosed();
          setConnecting(null);
        }}
      />
      <LinkAccountDialog
        open={linking ? { app: linking, confirm: null } : null}
        currentUserId={user?.id ?? null}
        onClose={() => {
          setLinking(null);
          void identitiesQuery.refetch();
        }}
      />
    </>
  );
});
