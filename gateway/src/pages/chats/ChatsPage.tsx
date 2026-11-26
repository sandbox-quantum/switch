import ChatBubbleOutlineOutlined from "@mui/icons-material/ChatBubbleOutlineOutlined";
import { Alert, Button, Snackbar, Stack, Typography } from "@mui/material";
import {
  AgentProfileHeader,
  type AgentLine,
  ConversationNote,
  ConversationSection,
  ProfileButton,
} from "@switch-console/chat-ui/components/agent-page";
import { AgentProfileActions } from "@switch-console/chat-ui/components/agent-profile-actions";
import { ArchivedFold } from "@switch-console/chat-ui/components/archived-fold";
import { ChatPanel, useAgentActivities } from "@switch-console/chat-ui/components/chat-panel";
import { ChatRow, RoomRow, UnsavedChatRow } from "@switch-console/chat-ui/components/chat-row";
import { ChatHeaderControls, ChatHeaderTitle } from "@switch-console/chat-ui/components/chat-header";
import { chatActions, ChatActionItems, type ChatRemovalContext } from "@switch-console/chat-ui/components/chat-actions";
import { MessagingAppBanner } from "@switch-console/chat-ui/components/messaging-app-banner";
import { MoveAgentModal, type MoveAgentMachine } from "@switch-console/chat-ui/components/move-agent-modal";
import { NewRoomRow } from "@switch-console/chat-ui/components/new-room-row";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { isBuddy } from "@switch-console/chat-ui/model/buddy";
import { buddySetupCardsEnabled } from "@switch-console/chat-ui/model/buddy-setup-step";
import { AgentAvatar, useChatHost, useOptionalChatHost } from "@switch-console/chat-ui/host";
import {
  agentConversations,
  byLatestDirectChat,
  isConsoleDirectChatSummary,
} from "@switch-console/chat-ui/model/agent-conversations";
import { inAppRooms } from "@switch-console/chat-ui/model/room-apps";
import {
  byActivity,
  holdingOpenRoom,
  roomActivityAt,
} from "@switch-console/chat-ui/model/room-order";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { Dialog, DialogContent } from "@switch-console/chat-ui/primitives/dialog";
import { SegmentedControl } from "@switch-console/chat-ui/primitives/segmented-control";
import { SidebarMenuRow } from "@switch-console/chat-ui/primitives/sidebar";
import type { ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { useQuery } from "@tanstack/react-query";
import { Laptop, Plug, Settings, UserRound } from "lucide-react";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import {
  Link as RouterLink,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  type AgentListEntry,
  type RoomSummary,
  fetchAgent,
  fetchRoom,
  loadAgents,
  loadRooms,
  loadRoomsWithArchived,
} from "../../data/api";
import { closeUnlessBusy } from "../../components/closeUnlessBusy";
import { useAuth } from "../../data/AuthContext";
import type { RoomsNotice } from "../rooms/RoomDetailPage";
import { agentsClient, useManagedAgent } from "../../data/useManagedAgent";
import { NewRoomDialog } from "./NewRoomDialog";
import { RoomChat } from "./RoomChat";
import { WebBuddySetupCards } from "./WebBuddySetupCards";
import { useWebChats } from "./WebChatHost";
import { webChatsClient, webFailures } from "./webChatClient";
import { WEB_SERVER_ID } from "./webServer";
import { fetchHostedMachines } from "../get-started/onboarding";
import { AgentConnectorsView, AgentSettingsView } from "./AgentSettingsView";
import type { Machine } from "@switch-console/chat-ui/client/agents-client";

const serverId = WEB_SERVER_ID;

function agentLabel(agent: Pick<AgentListEntry, "name" | "display_name">): string {
  return agent.display_name ?? agent.name;
}

const agentPath = (agentId: string, query = "") =>
  `/chats/agents/${encodeURIComponent(agentId)}${query}`;

function adaptMachineForMove(
  machine: Machine,
  provider: string,
  currentMachineId: string | null,
): MoveAgentMachine | null {
  if (machine.id === currentMachineId || machine.state === 'revoked') return null;
  const online = machine.state === 'online';
  const reported = machine.status?.providers.find((p) => p.provider === provider);
  let selectable = false;
  let tone: 'ok' | 'warning' | 'problem' | 'idle' = 'idle';
  let line = '';
  if (!online) {
    tone = 'idle';
    line = 'Offline. Bring it online to move agents here.';
  } else if (!reported) {
    tone = 'warning';
    line = `${provider} isn't installed here.`;
  } else if (reported.auth === 'ok') {
    selectable = true;
    tone = 'ok';
    line = `Ready: ${provider} signed in`;
  } else if (!reported.installed) {
    tone = 'warning';
    line = `${provider} isn't installed here.`;
  } else if (reported.auth === 'expired' || reported.auth === 'missing') {
    tone = 'warning';
    line = `${provider} ${reported.auth === 'expired' ? 'sign-in has expired' : "isn't signed in"} here. Sign in first.`;
  } else {
    selectable = true;
    tone = 'warning';
    line = `${provider}: ${reported.auth_problem ?? 'not checked yet'}`;
  }
  return {
    id: machine.id,
    name: machine.name,
    kind: machine.kind,
    state: machine.state,
    thisComputer: false,
    selectable,
    selectabilityTone: tone,
    selectabilityLine: line,
    namesake: null,
  };
}

/**
 * The agents the Chats page lists, as Console's sidebar does: the person's
 * own and any they have a chat with, by their newest direct chat.
 */
function listedAgents(agents: AgentListEntry[], chats: ChatsStore, userId: string | null) {
  const inChats = new Set(
    [...chats.chats.values()].flatMap((chat) => chat.agents.map((each) => each.id)),
  );
  return byLatestDirectChat(
    agents
      .filter((agent) => agent.owner_id === userId || inChats.has(agent.id))
      .map((agent) => ({ ...agent, agentId: agent.id })),
    chats.userId === null ? null : chats.chats.values(),
  );
}

const AgentList = observer(function AgentList({
  agents,
  selected,
}: {
  agents: AgentListEntry[];
  selected: string | null;
}) {
  const { chats } = useChatHost();
  const navigate = useNavigate();
  const listed = listedAgents(agents, chats, useAuth().user?.id ?? null);
  const unread = (agentId: string) =>
    chats.chatsOfAgent(agentId).reduce((sum, chat) => sum + chats.unread(chat.roomId), 0);
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Your agents">
      {listed.length === 0 && (
        <p className="px-[9px] py-2 text-xs text-foreground-muted">No agents yet.</p>
      )}
      {listed.map((agent) => {
        const count = unread(agent.id);
        const statusDotColor =
          agent.status === "online"
            ? "bg-foreground-success"
            : agent.status === "offline"
              ? "bg-[var(--fg-passive)]"
              : "bg-foreground-muted";
        const statusLabel =
          agent.status === "online"
            ? "Online"
            : agent.status === "offline"
              ? "Offline"
              : "Not tracked";
        return (
          <SidebarMenuRow
            key={agent.id}
            isActive={agent.id === selected}
            title={agentLabel(agent)}
            onClick={() => navigate(agentPath(agent.id))}
            className="h-[34px] py-0 text-[13.5px]"
          >
            <span className="relative flex size-[20px] shrink-0 items-center justify-center">
              <AgentAvatar
                name={agent.name}
                iconUrl={agent.icon_url ?? null}
                serverId={serverId}
                size={20}
              />
              <span
                role="img"
                aria-label={statusLabel}
                className={`absolute -right-[1px] -bottom-[1px] size-[6px] rounded-full ${statusDotColor}`}
              />
            </span>
            <span className="min-w-0 flex-1 truncate">{agentLabel(agent)}</span>
            {count > 0 && (
              <span
                aria-label={`${count} unread`}
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary-button-background px-1 text-[10px] leading-none font-medium text-primary-button-foreground tabular-nums"
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
          </SidebarMenuRow>
        );
      })}
    </div>
  );
});

type ListedRoom = {
  id: string;
  name: string;
  bridgeType: string | null;
  bridgeDisplayName: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
};

const roomPath = (roomId: string) => `/chats/rooms/${encodeURIComponent(roomId)}`;
const TAB_KEY = "gateway.chats.tab";
type Tab = "agents" | "rooms";

/**
 * How often the lists of agents and rooms are read again while the page is
 * open: an agent or a room made elsewhere (switch-buddy running a template,
 * say) carries no chat event to the person, so it shows within a minute, and
 * on coming back to the tab. The live chat feed updates most changes, so
 * polling is only for catching what the feed misses.
 */
const KEEP_FRESH = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;

function listedRoom(room: RoomSummary): ListedRoom {
  return {
    id: room.id,
    name: room.name,
    bridgeType: room.bridge_type ?? null,
    bridgeDisplayName: room.bridge_display_name,
    createdAt: room.created_at,
    lastMessageAt: room.last_message_at ?? null,
  };
}

/** The person's archived rooms on no messaging app, as Console's Rooms page lists them under Archived. */
function useArchivedRooms(chats: ChatsStore) {
  const rooms = useQuery({
    queryKey: ["chat-rooms", "archived"],
    queryFn: loadRoomsWithArchived,
    ...KEEP_FRESH,
  });
  const archived = inAppRooms(
    (rooms.data ?? []).filter(
      (room) =>
        room.archived &&
        (room.viewer_is_member || chats.archived.has(room.id)) &&
        !(room.is_console_chat && room.channel_type === "direct"),
    )
    .map(listedRoom),
  );
  return { archived, error: rooms.error ? `Your archived rooms could not be listed: ${rooms.error.message}` : null };
}

/**
 * The rooms the Chats page lists, as Console's sidebar does: the person's
 * rooms on no messaging app but their 1-1 chats with agents (those are under
 * each agent), and the group chats they are in.
 */
function useListedRooms(chats: ChatsStore): ListedRoom[] | null {
  const rooms = useQuery({ queryKey: ["chat-rooms"], queryFn: loadRooms, ...KEEP_FRESH });
  if (!rooms.data) return null;
  const listed: ListedRoom[] = rooms.data
    .filter(
      (room) =>
        !room.archived &&
        (room.viewer_is_member || chats.chat(room.id) !== undefined) &&
        !(room.is_console_chat && room.channel_type === "direct"),
    )
    .map(listedRoom);
  const ids = new Set(listed.map((room) => room.id));
  for (const chat of chats.chats.values()) {
    if (ids.has(chat.roomId) || isConsoleDirectChatSummary(chat)) continue;
    listed.push({
      id: chat.roomId,
      name: chat.name,
      bridgeType: chat.bridgeType,
      bridgeDisplayName: null,
      createdAt: null,
      lastMessageAt: chat.lastMessage?.sentAt ?? null,
    });
  }
  return inAppRooms(listed);
}

/** Where the open room sat in the list when it was opened, kept while it stays open (see `holdingOpenRoom`). */
function useHeldPlace(openId: string | null) {
  const held = useRef<{ id: string | null; place: number | null; shown: string[] }>({
    id: null,
    place: null,
    shown: [],
  });
  if (held.current.id !== openId) {
    const place = openId === null ? -1 : held.current.shown.indexOf(openId);
    held.current = { ...held.current, id: openId, place: place >= 0 ? place : null };
  }
  return {
    place: held.current.place,
    remember: (shown: string[]) => {
      held.current.shown = shown;
    },
  };
}

/** Where to connect a messaging app, New Room, then the rooms on none: unread first, then the most recently active. */
const RoomList = observer(function RoomList({
  rooms: listed,
  selected,
}: {
  rooms: ListedRoom[];
  selected: string | null;
}) {
  const { chats } = useChatHost();
  const navigate = useNavigate();
  const ordered = byActivity(listed, (room) => ({
    name: room.name,
    activityAt: roomActivityAt(chats.chat(room.id), room),
    unread: chats.unread(room.id) > 0,
  }));
  const { place, remember } = useHeldPlace(selected);
  const archived = useArchivedRooms(chats);
  const rooms = holdingOpenRoom(ordered, selected, place);
  remember(rooms.map((room) => room.id));
  const [params, setParams] = useSearchParams();
  // `?new=room` opens the dialog: where the dashboard's old New room page now leads.
  const [creating, setCreating] = useState(() => params.get("new") === "room");
  useEffect(() => {
    if (!params.has("new")) return;
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  }, [params, setParams]);
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Your rooms">
      <MessagingAppBanner onConnect={() => navigate("/settings/messaging-apps")} />
      <NewRoomRow onCreate={() => setCreating(true)} />
      <NewRoomDialog open={creating} onClose={() => setCreating(false)} />
      {rooms.length === 0 && (
        <p className="px-[9px] py-2 text-xs text-foreground-muted">No rooms here yet.</p>
      )}
      {rooms.map((room) => (
        <RoomRow
          key={room.id}
          roomId={room.id}
          room={room}
          isActive={room.id === selected}
          onOpen={() => navigate(roomPath(room.id))}
        />
      ))}
      {/* An archived room opens on its page, where it is unarchived. */}
      <ArchivedFold count={archived.archived.length} error={archived.error}>
        {archived.archived.map((room) => (
          <RoomRow
            key={room.id}
            roomId={room.id}
            room={room}
            isActive={false}
            onOpen={() => navigate(`/rooms/${encodeURIComponent(room.id)}/manage`)}
          />
        ))}
      </ArchivedFold>
    </div>
  );
});

/** A room opened from the Rooms list: its conversation when it is one of the person's chats. */
const RoomPane = observer(function RoomPane({ roomId }: { roomId: string }) {
  const { chats } = useChatHost();
  if (chats.chat(roomId)) return <RoomChat key={roomId} serverId={serverId} roomId={roomId} />;
  if (chats.userId === null && !chats.listError)
    return (
      <Typography color="text.secondary" sx={{ m: "auto" }}>
        Loading the room…
      </Typography>
    );
  return <NotYourChat roomId={roomId} />;
});

/** Where an agent runs, or whose it is when it runs on no device Switch knows of. */
function agentLine(agent: AgentListEntry, userId: string | null): AgentLine {
  const status = agent.status === "offline" ? "Offline" : null;
  if (agent.device)
    return {
      icon: Laptop,
      text: agent.device.name,
      status,
      title: `Runs on ${agent.device.owner_name}'s ${agent.device.name}`,
    };
  const own = agent.owner_id === userId;
  return {
    icon: UserRound,
    text: own ? "Your agent" : (agent.owner_name ?? "Shared agent"),
    status,
    title: own ? "You own this agent." : `Owned by ${agent.owner_name ?? "someone else"}`,
  };
}

/** The rooms an agent is in, as its page on the server lists them. */
function useAgentRooms(agentId: string) {
  return useQuery({
    queryKey: ["chat-agent-rooms", agentId],
    queryFn: async () => {
      const detail = await fetchAgent(agentId);
      if (detail === null) throw new Error("The agent's rooms could not be read.");
      return detail.rooms.map((room) => ({
        roomId: room.room_id,
        roomName: room.room_name,
        archived: room.archived,
      }));
    },
    ...KEEP_FRESH,
  });
}

/**
 * A room that is not one of the person's chats: named, and pointed at its
 * own page. Whoever manages a room on no messaging app may join its
 * conversation from here, as they could from Console.
 */
function NotYourChat({ roomId }: { roomId: string }) {
  const host = useChatHost();
  const { chats } = host;
  const userId = useAuth().user?.id ?? null;
  const room = useQuery({ queryKey: ["chat-room", roomId], queryFn: () => fetchRoom(roomId) });
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinable =
    room.data?.can_manage === true && room.data.bridge_id === null && userId !== null;
  // A room on a messaging app is talked in there, as Console opens it there.
  const app = room.data?.bridge_id ? host.bridgePlatformLabel(room.data.bridge_type ?? null) : null;
  const channelUrl = room.data?.external_channel_url ?? null;
  const join = async () => {
    setJoining(true);
    setError(null);
    try {
      await webChatsClient.addChatMember(roomId, userId!);
      await chats.refreshSummaries();
    } catch (caught) {
      setError(
        webFailures.describe(caught, "You could not join this room's conversation.").headline,
      );
    } finally {
      setJoining(false);
    }
  };
  return (
    <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 1.5, p: 4 }}>
      {room.data?.name && <Typography variant="h6">{room.data.name}</Typography>}
      <Typography sx={{ fontWeight: 600 }}>
        {app ? `This room's conversation is on ${app}` : "This room isn't one of your chats"}
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 420, textAlign: "center" }}>
        {app
          ? `Its people and agents talk in its ${app} channel. Open it there to read and join in.`
          : joinable
            ? "You manage this room, so you can join its conversation."
            : "Being able to see a room doesn't let you read its conversation. Ask its owner to add you."}
      </Typography>
      {error && <Typography color="error">{error}</Typography>}
      <Stack direction="row" spacing={1}>
        {joinable && (
          <Button variant="contained" disabled={joining} onClick={() => void join()}>
            Join the conversation
          </Button>
        )}
        {app && channelUrl && (
          <Button variant="contained" href={channelUrl} target="_blank" rel="noopener noreferrer">
            Open in {app}
          </Button>
        )}
        <Button component={RouterLink} to={`/rooms/${encodeURIComponent(roomId)}/manage`}>
          Open the room's page
        </Button>
      </Stack>
    </Stack>
  );
}

/** The buddy's Welcome chat, where its chat-app tiles are drawn: the direct chat named so, on no messaging app. */
function isWelcomeChat(chat: ChatSummary | undefined): boolean {
  return chat !== undefined && chat.name === "Welcome" && chat.bridgeType === null;
}

const DirectChatHeader = observer(function DirectChatHeader({
  serverId,
  roomId,
  context,
}: {
  serverId: string;
  roomId: string;
  context: ChatRemovalContext;
}) {
  const { chats } = useChatHost();
  const chat = chats.chat(roomId);
  const activities = useAgentActivities(serverId, chat ?? undefined);
  if (!chat) return null;
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-3">
      <ChatHeaderTitle serverId={serverId} chat={chat} />
      <ChatHeaderControls serverId={serverId} chat={chat} activities={activities} context={context} />
    </header>
  );
});

/**
 * An agent's page, as in Console: its profile, its direct chats and the
 * rooms it is in, with the one open beside the column. The selection is in
 * the address (`?chat=` or `?room=`); with none it is the newest direct chat,
 * and an agent with none gets an unsaved one, made when its first message is.
 */
const AgentPage = observer(function AgentPage({ agent }: { agent: AgentListEntry }) {
  const { chats } = useChatHost();
  const web = useWebChats()!;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user, capabilities } = useAuth();
  const userId = user?.id ?? null;
  const setupCards = buddySetupCardsEnabled(capabilities.features);
  const agentId = agent.id;
  const agentRooms = useAgentRooms(agentId);
  const managedAgent = useManagedAgent(agent.owner_id === userId ? agentId : null);
  const [updating, setUpdating] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const machinesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => agentsClient.listMachines(),
    enabled: moveModalOpen && managedAgent.data !== null,
  });
  // As on New agent: where Switch runs agents on Switch Cloud, there is no other device to move one to.
  const hosted = useQuery({ queryKey: ["hosted-machines"], queryFn: fetchHostedMachines });
  const onSwitchCloud = hosted.data !== undefined && (hosted.data.available || hosted.data.machines.length > 0);
  const openMove =
    hosted.isPending || onSwitchCloud
      ? null
      : () => {
          setMoveError(null);
          setMoveModalOpen(true);
        };
  const { direct, rooms } = agentConversations(
    chats.chatsOfAgent(agentId),
    agentRooms.data ?? [],
    chats.removed,
    (roomId) => roomActivityAt(chats.chat(roomId), null),
  );
  const archived = chats.archivedOfAgent(agentId).filter(isConsoleDirectChatSummary);
  const section = params.get("section");
  const shownRoom = section ? null : params.get("room");
  const chosen = section ? null : params.get("chat");
  const unsavedId = web.directChats.waiting(serverId, agentId);
  const roomId = shownRoom
    ? null
    : chosen && (web.directChats.unsavedChat(chosen) || chats.chat(chosen))
      ? chosen
      : (direct[0]?.roomId ?? null);
  const listed = chats.userId !== null;
  const open = (id: string) => setParams({ chat: id });
  const newChat = () => open(web.directChats.start(serverId, agentId));

  // A chat made from its unsaved id moves the address onto its room.
  useEffect(
    () =>
      web.onChatMade(({ from, to }) =>
        setParams((current) => (current.get("chat") === from ? { chat: to } : current), {
          replace: true,
        }),
      ),
    [web, setParams],
  );
  // An unsaved chat in the address after a reload opens again, with its draft.
  useEffect(() => {
    if (chosen && chosen === unsavedId && !web.directChats.unsavedChat(chosen))
      setParams({ chat: web.directChats.start(serverId, agentId) }, { replace: true });
  }, [chosen, unsavedId, web, agentId, setParams]);
  // An agent with no direct chat gets one started, once per visit, as in Console.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!listed || direct.length > 0 || chosen || shownRoom || section || autoStarted.current) return;
    autoStarted.current = true;
    setParams({ chat: web.directChats.start(serverId, agentId) }, { replace: true });
  }, [listed, direct.length, chosen, shownRoom, section, agentId, web, setParams]);

  const host = useChatHost();
  const context: ChatRemovalContext = {
    currentViewId: "managedAgent",
    chatRoomId: roomId ?? undefined,
    agentRoomId: undefined,
  };
  const chatRow = (chat: ChatSummary) => {
    const actions = chatActions(serverId, chat, { ...context, chatRoomId: chat.roomId }, host);
    return (
      <ChatRow
        key={chat.roomId}
        serverId={serverId}
        chat={chat}
        isActive={chat.roomId === roomId}
        onOpen={() => open(chat.roomId)}
        actions={<ChatActionItems actions={actions} />}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-border p-2">
        <AgentProfileHeader
          name={agentLabel(agent)}
          iconUrl={agent.icon_url ?? null}
          serverId={serverId}
          line={agentLine(agent, userId)}
          onOpenLine={
            agent.device
              ? () => navigate(`/settings/devices?device=${encodeURIComponent(agent.device!.id)}`)
              : null
          }
        >
          <div role="toolbar" aria-label="Agent" className="mt-5 flex flex-wrap items-center gap-2">
            <ProfileButton
              label="Settings"
              icon={Settings}
              pressed={section === "settings"}
              onClick={() =>
                section === "settings"
                  ? setParams(chosen ? { chat: chosen } : shownRoom ? { room: shownRoom } : {})
                  : setParams({ section: "settings" })
              }
            />
            {capabilities.features.service_connections && (
              <ProfileButton
                label="Connectors"
                icon={Plug}
                pressed={section === "connectors"}
                onClick={() =>
                  section === "connectors"
                    ? setParams(chosen ? { chat: chosen } : shownRoom ? { room: shownRoom } : {})
                    : setParams({ section: "connectors" })
                }
              />
            )}
            {managedAgent.error && (
              <Alert severity="error" sx={{ mx: 2, mt: 2 }}>
                Could not read agent management status: {managedAgent.error.message}
              </Alert>
            )}
            {toggleError && (
              <Alert severity="error" sx={{ mx: 2, mt: 2 }}>
                Could not {managedAgent.data?.desired_state === "running" ? "stop" : "start"} the agent: {toggleError}
              </Alert>
            )}
            {managedAgent.data && (
              <AgentProfileActions
                desiredState={managedAgent.data.desired_state}
                busy={updating}
                onToggleState={async () => {
                  setUpdating(true);
                  setToggleError(null);
                  try {
                    await agentsClient.updateManagedAgent(agentId, {
                      desired_state:
                        managedAgent.data!.desired_state === "running" ? "stopped" : "running",
                    });
                    await managedAgent.refetch();
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    setToggleError(message);
                  } finally {
                    setUpdating(false);
                  }
                }}
                onMove={openMove}
              />
            )}
          </div>
        </AgentProfileHeader>
        <ConversationSection
          title="Direct chats"
          addLabel="New chat"
          onAdd={newChat}
          addChoices={null}
        >
          {chats.listError && <ConversationNote>{chats.listError}</ConversationNote>}
          {unsavedId && <UnsavedChatRow isActive={unsavedId === roomId} onOpen={newChat} />}
          {direct.map(chatRow)}
          {direct.length === 0 && !unsavedId && !chats.listError && (
            <ConversationNote>No direct chats yet.</ConversationNote>
          )}
          <ArchivedFold count={archived.length} error={chats.archivedError}>
            {archived.map(chatRow)}
          </ArchivedFold>
        </ConversationSection>
        <ConversationSection
          title="Rooms"
          addLabel="New room"
          onAdd={() => setCreatingRoom(true)}
          addChoices={null}
        >
          {agentRooms.error && <ConversationNote>{agentRooms.error.message}</ConversationNote>}
          {rooms.map((room) => {
            const summary = chats.chat(room.roomId);
            return (
              <RoomRow
                key={room.roomId}
                roomId={room.roomId}
                room={{
                  name: summary?.name ?? room.roomName,
                  bridgeType: summary?.bridgeType ?? null,
                  bridgeDisplayName: null,
                }}
                isActive={room.roomId === shownRoom}
                onOpen={() => setParams({ room: room.roomId })}
              />
            );
          })}
          {agentRooms.isPending && <ConversationNote>Loading…</ConversationNote>}
          {agentRooms.data && rooms.length === 0 && (
            <ConversationNote>Not in any room yet.</ConversationNote>
          )}
        </ConversationSection>
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {section === "settings" ? (
          <AgentSettingsView
            agentId={agentId}
            managedAgent={managedAgent.data ?? null}
            onManagedChanged={managedAgent.refetch}
            onMove={openMove}
          />
        ) : section === "connectors" ? (
          <AgentConnectorsView agentId={agentId} />
        ) : shownRoom ? (
          chats.chat(shownRoom) ? (
            <RoomChat key={shownRoom} serverId={serverId} roomId={shownRoom} />
          ) : listed ? (
            <NotYourChat roomId={shownRoom} />
          ) : null
        ) : roomId ? (
          chats.chat(roomId) ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <DirectChatHeader serverId={serverId} roomId={roomId} context={context} />
              <ChatPanel
                key={roomId}
                serverId={serverId}
                roomId={roomId}
                afterMessages={
                  setupCards && isBuddy(agent) && isWelcomeChat(chats.chat(roomId)) ? (
                    <WebBuddySetupCards
                      serverId={serverId}
                      roomId={roomId}
                      agentId={agentId}
                      agentName={agent.name}
                    />
                  ) : null
                }
              />
            </div>
          ) : (
            <ChatPanel
              key={roomId}
              serverId={serverId}
              roomId={roomId}
              afterMessages={
                setupCards && isBuddy(agent) && isWelcomeChat(chats.chat(roomId)) ? (
                  <WebBuddySetupCards
                    serverId={serverId}
                    roomId={roomId}
                    agentId={agentId}
                    agentName={agent.name}
                  />
                ) : null
              }
            />
          )
        ) : listed ? (
          <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 1 }}>
            <Typography color="text.secondary">No chat open</Typography>
            <Button variant="contained" onClick={newChat}>
              Start a chat
            </Button>
          </Stack>
        ) : null}
      </div>
      <NewRoomDialog open={creatingRoom} onClose={() => setCreatingRoom(false)} agentId={agentId} />
      <Dialog open={moveModalOpen} onOpenChange={closeUnlessBusy(moving, () => setMoveModalOpen(false))}>
        <DialogContent>
          {managedAgent.data && (
            <MoveAgentModal
              agentName={agentLabel(agent)}
              currentMachineName={managedAgent.data.controller_name}
              workingDirectory={managedAgent.data.definition.directory}
              machines={
                machinesQuery.data
                  ? machinesQuery.data
                      .map((m) =>
                        adaptMachineForMove(
                          m,
                          managedAgent.data!.definition.provider,
                          managedAgent.data!.controller_id,
                        ),
                      )
                      .filter((m): m is MoveAgentMachine => m !== null)
                      .sort(
                        (a, b) =>
                          Number(b.selectable) - Number(a.selectable) ||
                          a.name.localeCompare(b.name),
                      )
                  : null
              }
              machinesError={
                machinesQuery.error ? String(machinesQuery.error) : null
              }
              moving={moving}
              moveError={moveError}
              onMove={async (machineId: string) => {
                setMoving(true);
                setMoveError(null);
                try {
                  await agentsClient.updateManagedAgent(agentId, {
                    controller_id: machineId,
                  });
                  await managedAgent.refetch();
                  setMoveModalOpen(false);
                } catch (err) {
                  let message = err instanceof Error ? err.message : String(err);
                  try {
                    const parsed = JSON.parse(message);
                    message = parsed.detail ?? message;
                  } catch {
                    // Not JSON, use as-is
                  }
                  setMoveError(message);
                } finally {
                  setMoving(false);
                }
              }}
              onClose={() => setMoveModalOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
});

/**
 * A chat opened by its room (from a room's page, or a link): shown on its
 * agent's page, or said not to be one of the person's chats.
 */
const ChatByRoom = observer(function ChatByRoom({ roomId }: { roomId: string }) {
  const agents = useQuery({ queryKey: ["chat-agents"], queryFn: loadAgents });
  const { chats } = useChatHost();
  if (roomId === "agents" || roomId === "rooms") return <Navigate replace to="/chats" />;
  const chat = chats.chat(roomId);
  if (chat) {
    const agent = chat.agents[0];
    if (!agent) return <ChatPanel key={roomId} serverId={serverId} roomId={roomId} />;
    if (!agents.data)
      return (
        <Typography color="text.secondary" sx={{ m: "auto" }}>
          Loading the chat…
        </Typography>
      );
    if (!agents.data.some((a) => a.id === agent.id))
      return <ChatPanel key={roomId} serverId={serverId} roomId={roomId} />;
    const key = isConsoleDirectChatSummary(chat) ? "chat" : "room";
    return <Navigate replace to={agentPath(agent.id, `?${key}=${encodeURIComponent(roomId)}`)} />;
  }
  if (chats.userId === null && !chats.listError)
    return (
      <Typography color="text.secondary" sx={{ m: "auto" }}>
        Loading the chat…
      </Typography>
    );
  return <NotYourChat roomId={roomId} />;
});

const Chats = observer(function Chats() {
  const web = useWebChats();
  useEffect(() => {
    if (!web) return;
    web.start();
    return () => web.stop();
  }, [web]);
  const { agentId, roomId: linkedRoomId } = useParams<{ agentId?: string; roomId?: string }>();
  const [params] = useSearchParams();
  const location = useLocation();
  const inRooms = location.pathname.startsWith("/chats/rooms/");
  // What a room's page left to say on sending someone here: a deleted room's
  // channel left to clean up by hand, say. Kept until dismissed.
  const [notice, setNotice] = useState(() => (location.state as RoomsNotice | null)?.notice ?? null);
  const navigate = useNavigate();
  useEffect(() => {
    if (location.state) navigate(location.pathname + location.search, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);
  const roomId = inRooms ? null : (linkedRoomId ?? null);
  const shownRoom = inRooms ? (linkedRoomId ?? null) : null;
  const agents = useQuery({ queryKey: ["chat-agents"], queryFn: loadAgents, ...KEEP_FRESH });
  const { chats } = useChatHost();
  const userId = useAuth().user?.id ?? null;
  const rooms = useListedRooms(chats);
  const [tab, setTab] = useState<Tab>(() => {
    const urlTab = params.get("tab");
    if (urlTab === "rooms" || urlTab === "agents") return urlTab;
    return shownRoom
      ? "rooms"
      : agentId
        ? "agents"
        : localStorage.getItem(TAB_KEY) === "rooms"
          ? "rooms"
          : "agents";
  });
  // Opening a room shows the Rooms list, an agent the Agents list; switching
  // the list leaves what is open beside it, as in Console.
  useEffect(() => {
    const urlTab = params.get("tab");
    if (urlTab === "rooms" || urlTab === "agents") {
      setTab(urlTab);
    } else if (shownRoom) {
      setTab("rooms");
    } else if (agentId) {
      setTab("agents");
    }
  }, [shownRoom, agentId, params]);
  const agent = agents.data?.find((each) => each.id === agentId) ?? null;
  const listedCount =
    tab === "agents"
      ? agents.data
        ? listedAgents(agents.data, chats, userId).length
        : null
      : (rooms?.length ?? null);
  // While the agents show, a dot on Rooms says a room has something new.
  const roomsUnread = (rooms ?? []).some((room) => chats.unread(room.id) > 0);

  let main = null;
  if (shownRoom) main = <RoomPane roomId={shownRoom} />;
  else if (roomId) main = <ChatByRoom roomId={roomId} />;
  else if (agent) main = <AgentPage key={agent.id} agent={agent} />;
  else if (agents.error)
    main = (
      <Typography color="error" sx={{ m: "auto" }}>
        The agents could not be listed.
      </Typography>
    );
  else if (agents.data && agentId)
    main = (
      <Typography color="text.secondary" sx={{ m: "auto" }}>
        There's no agent here, or you can't see it.
      </Typography>
    );
  else if (agents.data) {
    const some = tab === "agents" ? listedAgents(agents.data, chats, userId).length > 0 : true;
    main = (
      <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 1, p: 4 }}>
        <ChatBubbleOutlineOutlined sx={{ fontSize: 40, opacity: 0.4 }} />
        <Typography color="text.secondary">
          {tab === "rooms"
            ? "Pick a room."
            : some
              ? "Pick an agent to chat with."
              : "No agents to chat with yet."}
        </Typography>
        {!some && (
          <Button component={RouterLink} to="/agents">
            Go to Agents
          </Button>
        )}
      </Stack>
    );
  }

  return (
    <div className={`${SHARED_UI_CLASS} -m-8 flex min-h-0 flex-1 bg-background`}>
      <div className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-border px-2">
        <div className="flex items-center justify-between px-[9px] pt-4 pb-1.5">
          <SegmentedControl
            value={tab}
            onChange={(next) => {
              setTab(next);
              localStorage.setItem(TAB_KEY, next);
            }}
            options={[
              { value: "agents", label: "Agents" },
              { value: "rooms", label: "Rooms", dot: roomsUnread && tab !== "rooms" },
            ]}
            ariaLabel="Show agents or rooms"
            quiet
          />
          <span className="text-[11.5px] text-foreground-passive tabular-nums">{listedCount}</span>
        </div>
        {tab === "agents"
          ? agents.data && <AgentList agents={agents.data} selected={agent?.id ?? null} />
          : rooms && <RoomList rooms={rooms} selected={shownRoom} />}
      </div>
      {main}
      <Snackbar open={notice !== null} anchorOrigin={{ vertical: "top", horizontal: "center" }}>
        <Alert severity="warning" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      </Snackbar>
    </div>
  );
});

/** The person's agents and, for the one picked, its direct chats and rooms, as Console lays them out. */
export default function ChatsPage() {
  const host = useOptionalChatHost();
  const web = useWebChats();
  if (!host || !web)
    return (
      <Typography variant="body2" color="text.secondary">
        Loading your chats…
      </Typography>
    );
  return <Chats />;
}
