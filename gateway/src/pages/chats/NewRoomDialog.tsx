import {
  type CreateRoomAgents,
  type CreateRoomBridgePerson,
  CreateRoomDialog,
  type CreateRoomHost,
} from "@switch-console/chat-ui/components/create-room-dialog";
import {
  MessagingAppSelector,
  type MessagingAppSelectorProps,
} from "@switch-console/chat-ui/components/messaging-app-selector";
import { useChatHost } from "@switch-console/chat-ui/host";
import { agentParticipant } from "@switch-console/chat-ui/model/participant-search";
import { roomAccessForChannel } from "@switch-console/chat-ui/model/room-access";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Dialog, DialogContent } from "@switch-console/chat-ui/primitives/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import {
  type BridgeDetail,
  fetchBridges,
  fetchMyIdentities,
  fetchRoomAgentCandidates,
  fetchRoomGroups,
  loadAgents,
} from "../../data/api";
import { closeUnlessBusy } from "../../components/closeUnlessBusy";
import { useAuth } from "../../data/AuthContext";
import { accountName } from "../messaging-apps/chatAccounts";
import { WEB_PARTICIPANT_MARKS, useWebBridgeIcons } from "./WebChatHost";
import { callGateway, webChatsClient } from "./webChatClient";
import { WEB_SERVER_ID } from "./webServer";

/** Someone Switch knows on a messaging app, as `/collaborations/{id}/users` lists them. */
type BridgeUserJson = {
  external_user_id: string;
  external_username: string;
  claimed_by?: { user_id: string; user_name: string | null; verified?: boolean }[] | null;
};

function bridgeOf(bridge: BridgeDetail) {
  return {
    id: bridge.bridge_id,
    type: bridge.bridge_type,
    displayName: bridge.display_name,
    status: bridge.status,
    canCreateChannels: bridge.channel_creation_supported && bridge.channel_creation_enabled,
    channelIdsRefused: bridge.channel_ids_refused ?? null,
    privateChannels: bridge.private_channels_supported ?? null,
    privateChannelNeedsLinkedAccount: bridge.private_channel_needs_linked_account ?? false,
    publicChannelAddsCreator: bridge.public_channel_adds_creator ?? false,
  };
}

async function bridgePeople(bridgeId: string): Promise<CreateRoomBridgePerson[]> {
  const response = await callGateway(`/collaborations/${encodeURIComponent(bridgeId)}/users`, {});
  const users = (await response.json()) as BridgeUserJson[];
  return users
    .map((user) => {
      const linked = (user.claimed_by ?? []).filter((claim) => claim.verified !== false);
      return {
        username: user.external_username,
        externalUserId: user.external_user_id,
        linkedUserIds: linked.map((claim) => claim.user_id),
        linkedName: linked[0]?.user_name ?? null,
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username));
}

function WebMessagingAppSelector(props: MessagingAppSelectorProps) {
  return <MessagingAppSelector {...props} homeLabel="Switch" icons={useWebBridgeIcons()} />;
}

function WebConfirmButton(props: { onClick: () => void; disabled: boolean; children: ReactNode }) {
  return <Button {...props} />;
}

/**
 * The New room dialog Console has, on the web: the room is made through the
 * dashboard's own routes and opened in Chats. Opened from an agent's page it
 * starts with that agent picked.
 */
export function NewRoomDialog({
  open,
  onClose,
  agentId,
}: {
  open: boolean;
  onClose: () => void;
  agentId?: string;
}) {
  const [guarded, setGuarded] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={closeUnlessBusy(guarded, onClose)}
    >
      <DialogContent className="sm:max-w-2xl">
        {open && <NewRoom agentId={agentId} onClose={onClose} setGuarded={setGuarded} />}
      </DialogContent>
    </Dialog>
  );
}

function NewRoom({
  agentId,
  onClose,
  setGuarded,
}: {
  agentId?: string;
  onClose: () => void;
  setGuarded: (guarded: boolean) => void;
}) {
  const { chats } = useChatHost();
  const { session, user, canAdminTenant } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = session?.tenant?.id ?? null;
  const myUserId = user?.id ?? null;

  const bridges = useQuery({
    queryKey: ["new-room", "bridges"],
    queryFn: async () => ((await fetchBridges()) ?? []).map(bridgeOf),
  });
  const roster = useQuery({
    queryKey: ["workspace-members", tenantId],
    queryFn: () => webChatsClient.listWorkspaceMembers(tenantId!),
    enabled: tenantId !== null,
  });
  const identities = useQuery({ queryKey: ["new-room", "identities"], queryFn: fetchMyIdentities });
  const groups = useQuery({
    queryKey: ["new-room", "groups"],
    queryFn: async () => (await fetchRoomGroups()) ?? [],
    enabled: canAdminTenant,
  });

  function useAgents(bridged: boolean, groupId: string | null): CreateRoomAgents {
    const agents = useQuery({ queryKey: ["chat-agents"], queryFn: loadAgents });
    const allowed = useQuery({
      queryKey: ["new-room", "agent-candidates", groupId],
      queryFn: () => webChatsClient.listAgentCandidates(null, groupId),
    });
    // The agents the server's invite rule lets this person put into a room on a messaging app.
    const invitable = useQuery({
      queryKey: ["new-room", "invitable-agents"],
      queryFn: () => fetchRoomAgentCandidates(),
    });
    const listed = (agents.data ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.display_name,
      iconUrl: agent.icon_url ?? null,
      owner: agent.owner_id === myUserId ? "Your agent" : (agent.owner_name ?? "Shared agent"),
    }));
    let offered: typeof listed = [];
    if (bridged) {
      const ids = invitable.data?.agent_ids;
      if (ids === null) offered = listed;
      else if (ids !== undefined) offered = listed.filter((agent) => ids.includes(agent.id));
    } else {
      const ids = new Set(allowed.data ?? []);
      offered = listed.filter((agent) => ids.has(agent.id));
    }
    const failed = agents.isError || (!bridged && allowed.isError);
    return {
      offered: offered.map((agent) => agentParticipant(agent, agent.owner)),
      all: listed,
      loading: agents.isLoading || (!bridged && allowed.isLoading),
      loaded:
        agents.isSuccess &&
        !agents.isFetching &&
        (!bridged || !invitable.isPending) &&
        (bridged || (allowed.isSuccess && !allowed.isFetching)),
      error: failed ? (agents.error ?? allowed.error) : null,
      inviteError: bridged && invitable.isError ? invitable.error : null,
    };
  }

  function useBridgePeople(bridgeId: string | null) {
    return useQuery({
      queryKey: ["new-room", "bridge-people", bridgeId],
      queryFn: () => bridgePeople(bridgeId!),
      enabled: bridgeId !== null,
    });
  }

  function opened(roomId: string) {
    void queryClient.invalidateQueries({ queryKey: ["chat-rooms"] });
    void queryClient.invalidateQueries({ queryKey: ["chat-agent-rooms"] });
    navigate(`/chats/rooms/${encodeURIComponent(roomId)}`);
  }

  const host: CreateRoomHost = {
    serverId: WEB_SERVER_ID,
    workspaceId: tenantId,
    hasServer: true,
    myUserId,
    administers: canAdminTenant,
    // Rooms with no messaging app are always on: the server's group chats have no off.
    consoleOffered: true,
    appName: "Switch",
    bridges,
    roster: {
      ...roster,
      data: roster.data?.filter(
        (person) => !person.serviceAccount && person.userId !== myUserId,
      ),
    },
    identities:
      identities.data?.map((each) => ({
        bridgeId: each.bridge_id,
        externalUserId: each.external_user_id,
        name: accountName(each),
        verified: each.verified,
      })) ?? null,
    groups,
    useAgents,
    useBridgePeople,
    fetchBridgePeople: (bridgeId) =>
      queryClient.fetchQuery({
        queryKey: ["new-room", "bridge-people", bridgeId],
        queryFn: () => bridgePeople(bridgeId),
      }),
    createChat: async (params) => {
      const chat = await webChatsClient.createChat(params);
      chats.add(WEB_SERVER_ID, chat);
      opened(chat.roomId);
      return chat.roomId;
    },
    createRoom: async (params) => {
      // What the dialog shows is what is asked for: a new channel's visibility is
      // sent, and an existing channel's is the platform's, read by the server.
      const access = params.access ?? roomAccessForChannel(params.channel);
      const response = await callGateway("/rooms", {
        method: "POST",
        body: {
          name: params.name,
          description: params.description,
          instructions: params.instructions ?? null,
          bridge_id: params.bridgeId,
          ...(params.channel.kind === "existing"
            ? { external_channel_id: params.channel.externalChannelId }
            : { channel_type: params.channel.private ? "channel_private" : "channel_public" }),
          ...(params.groupId ? { group_id: params.groupId } : {}),
          ...(access === "private"
            ? { read_visibility: "private", write_visibility: "private" }
            : access === "public"
              ? { read_visibility: "public" }
              : {}),
          agent_ids: params.agentIds,
          ...(params.userNames.length ? { user_names: params.userNames } : {}),
        },
      });
      const room = (await response.json()) as { id: string };
      opened(room.id);
      return { kind: "created", room };
    },
    setCloseGuard: setGuarded,
    marks: WEB_PARTICIPANT_MARKS,
    MessagingAppSelector: WebMessagingAppSelector,
    ConfirmButton: WebConfirmButton,
  };

  return (
    <CreateRoomDialog host={host} startingAgentId={agentId} onSuccess={onClose} onClose={onClose} />
  );
}
