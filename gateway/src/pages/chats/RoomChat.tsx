import { ChatPanel, useAgentActivities } from "@switch-console/chat-ui/components/chat-panel";
import { ChatHeaderTitle, ChatHeaderControls } from "@switch-console/chat-ui/components/chat-header";
import {
  type RosterAgent,
  type RosterPerson,
  RoomRoster,
} from "@switch-console/chat-ui/components/room-roster";
import { type ChatSummary, chatAgentLabel } from "@switch-console/chat-ui/contracts/chats";
import { AgentAvatar, useChatHost } from "@switch-console/chat-ui/host";
import { Button } from "@switch-console/chat-ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogHeader,
  DialogTitle,
} from "@switch-console/chat-ui/primitives/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DoorOpen } from "lucide-react";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../../data/AuthContext";
import {
  type AgentListEntry,
  addRoomAgents,
  fetchRoom,
  loadAgents,
  removeRoomAgent,
} from "../../data/api";
import { webChatsClient, webFailures } from "./webChatClient";
import RoomResourcesSection from "../rooms/RoomResourcesSection";
import RoomAutoRouteSection from "../rooms/RoomAutoRouteSection";
import RoomGroupSection from "../rooms/RoomGroupSection";

type RoomTab = "chat" | "resources" | "configuration";

export const RoomChat = observer(function RoomChat({
  serverId,
  roomId,
}: {
  serverId: string;
  roomId: string;
}) {
  const { chats } = useChatHost();
  const chat = chats.chat(roomId);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as RoomTab) || "chat";
  const activities = useAgentActivities(serverId, chat ?? undefined);
  const context = {
    currentViewId: "room",
    chatRoomId: undefined,
    roomRoomId: roomId,
    agentRoomId: undefined,
  };
  if (!chat) return null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RoomHeader
        serverId={serverId}
        chat={chat}
        tab={tab}
        onTabChange={(next) => setSearchParams(p => { p.set('tab', next); return p; })}
        activities={activities}
        context={context}
      />
      <div className="flex min-h-0 flex-1">
        {tab === "chat" && (
          <>
            <WebRoomRoster serverId={serverId} chat={chat} />
            <div className="relative flex min-w-0 flex-1 flex-col">
              <ChatPanel key={roomId} serverId={serverId} roomId={roomId} />
            </div>
          </>
        )}
        {tab === "resources" && <RoomResourcesTab roomId={roomId} />}
        {tab === "configuration" && <RoomConfigurationTab roomId={roomId} />}
      </div>
    </div>
  );
});

function RoomHeader({
  serverId,
  chat,
  tab,
  onTabChange,
  activities,
  context,
}: {
  serverId: string;
  chat: ChatSummary;
  tab: RoomTab;
  onTabChange: (tab: RoomTab) => void;
  activities: ReturnType<typeof useAgentActivities>;
  context: { currentViewId: string; chatRoomId?: string; roomRoomId?: string; agentRoomId?: string };
}) {
  const host = useChatHost();
  const inSwitch = chat.bridgeType === null;
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <DoorOpen aria-hidden className="size-4 shrink-0 text-foreground-muted" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <ChatHeaderTitle serverId={serverId} chat={chat} />
          <span className="shrink-0 rounded-md bg-background-2 px-1.5 py-0.5 text-xs text-foreground-muted">
            {inSwitch
              ? chat.channelType === "group"
                ? "Group chat"
                : "Chat"
              : host.bridgePlatformLabel(chat.bridgeType)}
          </span>
        </div>
      </div>
      <nav aria-label="Room" className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant={tab === "chat" ? "secondary" : "ghost"}
          aria-current={tab === "chat" ? "page" : undefined}
          onClick={() => onTabChange("chat")}
        >
          Chat
        </Button>
        <Button
          size="sm"
          variant={tab === "resources" ? "secondary" : "ghost"}
          aria-current={tab === "resources" ? "page" : undefined}
          onClick={() => onTabChange("resources")}
        >
          Resources
        </Button>
        <Button
          size="sm"
          variant={tab === "configuration" ? "secondary" : "ghost"}
          aria-current={tab === "configuration" ? "page" : undefined}
          onClick={() => onTabChange("configuration")}
        >
          Configuration
        </Button>
      </nav>
      <ChatHeaderControls
        serverId={serverId}
        chat={chat}
        activities={activities}
        context={context}
      />
    </header>
  );
}

/** Who is in the room, from the web's own reads: the chat's members, or the room's roster on Switch. */
const WebRoomRoster = observer(function WebRoomRoster({
  serverId,
  chat,
}: {
  serverId: string;
  chat: ChatSummary;
}) {
  const { chats } = useChatHost();
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const roomId = chat.roomId;
  const inSwitch = chat.bridgeType === null;
  const viewerId = user?.id ?? null;

  const room = useQuery({
    queryKey: ["chat-room-roster", roomId],
    queryFn: () => fetchRoom(roomId),
    refetchInterval: 15_000,
  });
  const members = useQuery({
    queryKey: ["chat-members", roomId],
    queryFn: () => webChatsClient.listChatMembers(roomId),
    enabled: inSwitch,
  });
  const agents = useQuery({ queryKey: ["chat-agents"], queryFn: loadAgents });
  const byId = new Map((agents.data ?? []).map((agent) => [agent.id, agent]));
  const chatAgents = new Map(chat.agents.map((agent) => [agent.id, agent]));
  const detail = room.data ?? null;
  const agentIds = inSwitch ? chat.agents.map((agent) => agent.id) : (detail?.agent_ids ?? []);
  const manageChat = inSwitch && chat.canManage && chat.channelType === "group";
  const manageRoom = !inSwitch && detail?.can_manage === true;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["chat-room-roster", roomId] }),
      queryClient.invalidateQueries({ queryKey: ["chat-members", roomId] }),
      chats.refreshSummaries(),
    ]);
  };

  const agentRows: RosterAgent[] = agentIds.map((agentId) => {
    const listed = byId.get(agentId);
    const inChat = chatAgents.get(agentId);
    const label = inChat
      ? chatAgentLabel(inChat)
      : (listed?.display_name ?? listed?.name ?? "Agent");
    const ownedHere = listed?.owner_id !== null && listed?.owner_id === viewerId;
    return {
      id: agentId,
      label,
      mark: (
        <span className="flex size-7 shrink-0 items-center justify-center">
          <AgentAvatar
            name={label}
            iconUrl={inChat?.iconUrl ?? listed?.icon_url ?? null}
            serverId={serverId}
            size={26}
          />
        </span>
      ),
      status: detail?.agent_statuses[agentId],
      roles: (detail?.roles ?? [])
        .filter((role) => listed && role.held_by.includes(listed.name))
        .map((role) => role.name),
      open: ownedHere
        ? () =>
            navigate(
              `/chats/agents/${encodeURIComponent(agentId)}?room=${encodeURIComponent(roomId)}`,
            )
        : null,
      joinEvents: null,
      remove: manageChat
        ? async () => {
            await webChatsClient.removeChatAgent(roomId, agentId);
            chats.dropAgent(roomId, agentId);
          }
        : manageRoom || (ownedHere && !inSwitch)
          ? async () => {
              await removeRoomAgent(roomId, agentId);
              await refresh();
            }
          : null,
    };
  });

  const people: RosterPerson[] = inSwitch
    ? (members.data ?? []).map((member) => ({
        key: member.userId,
        name: member.name,
        userId: member.userId,
        fullName: null,
        detail: member.isOwner ? "owner" : null,
        actions:
          manageChat && !member.isOwner
            ? [
                {
                  label: "Remove from room",
                  run: async () => {
                    await webChatsClient.removeChatMember(roomId, member.userId);
                    await refresh();
                  },
                  failure: `Could not remove ${member.name}.`,
                  destructive: true,
                },
              ]
            : [],
      }))
    : (detail?.connected_user_names ?? []).map((name) => ({
        key: name,
        name,
        userId: null,
        fullName: null,
        detail: null,
        actions: [],
      }));

  const admins =
    !inSwitch && detail?.room_admins && detail.room_admins.length > 0 ? detail.room_admins : null;

  return (
    <RoomRoster
      addParticipants={manageChat ? () => setAdding(true) : null}
      agents={{
        title: "Agents",
        count: agentIds.length,
        onAdd: manageRoom ? () => setAdding(true) : null,
        addLabel: "Add agents",
        rows: room.isError && !inSwitch ? [] : agentRows,
        empty:
          room.isError && !inSwitch
            ? webFailures.describe(room.error, "Could not read who is in this room.").headline
            : agentIds.length === 0
              ? "No agents in this room yet."
              : null,
        notes: [],
      }}
      people={{
        title: inSwitch ? "People" : "People seen here",
        count: people.length,
        onAdd: null,
        addLabel: "Add people",
        rows: people,
        empty:
          people.length > 0
            ? null
            : inSwitch
              ? "Nobody else is here yet."
              : "Nobody has been seen here yet.",
        notes: inSwitch
          ? []
          : ["People who posted here or were added through Switch. The channel may have more."],
      }}
      admins={
        admins && {
          title: "Room admins",
          count: admins.length,
          onAdd: null,
          addLabel: "Add room admin",
          rows: admins.map((admin) => ({
            key: admin.user_id,
            name: admin.name ?? "Someone",
            userId: admin.user_id,
            fullName: null,
            detail: admin.user_id === viewerId ? "you" : null,
            actions: [],
          })),
          empty: null,
          notes: [],
        }
      }
      describe={(cause, fallback) => webFailures.describe(cause, fallback).headline}
      dialog={
        <Dialog open={adding} onOpenChange={(open) => !open && setAdding(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{inSwitch ? "Add participants" : "Add agents"}</DialogTitle>
            </DialogHeader>
            <DialogContentArea className="flex flex-col gap-3 pt-0">
              {adding && (
                <AddToRoom
                  chat={chat}
                  tenantId={session?.tenant?.id ?? null}
                  agents={agents.data ?? []}
                  agentIds={new Set(agentIds)}
                  memberIds={new Set((members.data ?? []).map((member) => member.userId))}
                  onAdded={refresh}
                />
              )}
            </DialogContentArea>
          </DialogContent>
        </Dialog>
      }
    />
  );
});

/**
 * Who can be added: the agents the viewer may add and, to a chat in Switch,
 * the workspace's people. Each is added on its own click.
 */
function AddToRoom({
  chat,
  tenantId,
  agents,
  agentIds,
  memberIds,
  onAdded,
}: {
  chat: ChatSummary;
  tenantId: string | null;
  agents: AgentListEntry[];
  agentIds: Set<string>;
  memberIds: Set<string>;
  onAdded: () => Promise<void>;
}) {
  const inSwitch = chat.bridgeType === null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = useQuery({
    queryKey: ["chat-agent-candidates", chat.roomId],
    queryFn: () => webChatsClient.listAgentCandidates(chat.roomId),
    enabled: inSwitch,
  });
  const people = useQuery({
    queryKey: ["workspace-members", tenantId],
    queryFn: () => webChatsClient.listWorkspaceMembers(tenantId as string),
    enabled: inSwitch && tenantId !== null,
  });
  const allowed = inSwitch ? new Set(candidates.data ?? []) : null;
  const addable = agents.filter(
    (agent) => !agentIds.has(agent.id) && (allowed === null || allowed.has(agent.id)),
  );
  const addablePeople = (people.data ?? []).filter((person) => !memberIds.has(person.userId));

  const add = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await onAdded();
    } catch (cause) {
      setError(webFailures.describe(cause, "That could not be added.").headline);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="text-xs font-medium text-foreground-muted">Agents</p>
      {addable.length === 0 && <p className="text-sm text-foreground-muted">No agents to add.</p>}
      {addable.map((agent) => (
        <div key={agent.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">
            {agent.display_name ?? agent.name}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void add(agent.id, () =>
                inSwitch
                  ? webChatsClient.addChatAgent(chat.roomId, agent.id)
                  : addRoomAgents(chat.roomId, [agent.id]),
              )
            }
          >
            Add
          </Button>
        </div>
      ))}
      {inSwitch && (
        <>
          <p className="pt-2 text-xs font-medium text-foreground-muted">People</p>
          {addablePeople.length === 0 && (
            <p className="text-sm text-foreground-muted">No one else to add.</p>
          )}
          {addablePeople.map((person) => (
            <div key={person.userId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void add(person.userId, () =>
                    webChatsClient.addChatMember(chat.roomId, person.userId),
                  )
                }
              >
                Add
              </Button>
            </div>
          ))}
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}

function RoomResourcesTab({ roomId }: { roomId: string }) {
  const { user } = useAuth();
  const room = useQuery({
    queryKey: ["chat-room-roster", roomId],
    queryFn: () => fetchRoom(roomId),
  });
  const detail = room.data ?? null;
  const viewerId = user?.id ?? null;
  const inRoom = detail?.viewer_is_member ?? false;
  const canAttach = detail?.can_attach ?? false;
  const canUnlink = detail?.can_unlink ?? false;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-6">
        <RoomResourcesSection
          roomId={roomId}
          canAttach={canAttach}
          canUnlink={canUnlink}
          inRoom={inRoom}
          viewerId={viewerId}
        />
      </div>
    </div>
  );
}

function RoomConfigurationTab({ roomId }: { roomId: string }) {
  const { canAdminTenant } = useAuth();
  const queryClient = useQueryClient();
  const room = useQuery({
    queryKey: ["chat-room-roster", roomId],
    queryFn: () => fetchRoom(roomId),
  });
  const detail = room.data ?? null;

  if (!detail) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <p className="text-sm text-foreground-muted">Loading...</p>
      </div>
    );
  }

  const canWrite = detail.can_write === true;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <RoomGroupSection
          room={detail}
          canWrite={canWrite}
          canFile={canAdminTenant}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["chat-room-roster", roomId] })}
        />
        {detail.auto_route && (
          <RoomAutoRouteSection room={detail} autoRoute={detail.auto_route} canWrite={canWrite} />
        )}
      </div>
    </div>
  );
}
