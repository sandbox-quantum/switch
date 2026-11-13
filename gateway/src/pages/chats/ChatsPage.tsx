import AddOutlined from "@mui/icons-material/AddOutlined";
import ChatBubbleOutlineOutlined from "@mui/icons-material/ChatBubbleOutlineOutlined";
import {
  Alert,
  Badge,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import { ChatPanel } from "@switch-console/chat-ui/components/chat-panel";
import { type ChatSummary, chatAgentLabel } from "@switch-console/chat-ui/contracts/chats";
import { useChatHost, useOptionalChatHost } from "@switch-console/chat-ui/host";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { type AgentSummary, fetchAgents, fetchRoom } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { ChatRequestError, webChatsClient, webFailures } from "./webChatClient";
import { WEB_SERVER_ID } from "./webServer";

function chatTitle(chat: ChatSummary): string {
  if (chat.channelType === "direct" && chat.agents.length === 1) return chatAgentLabel(chat.agents[0]!);
  return chat.name;
}

function byActivity(a: ChatSummary, b: ChatSummary): number {
  return (b.lastMessage?.sentAt ?? "").localeCompare(a.lastMessage?.sentAt ?? "");
}

const ChatList = observer(function ChatList({
  selected,
  onOpen,
}: {
  selected: string | null;
  onOpen: (roomId: string) => void;
}) {
  const { chats } = useChatHost();
  const listed = [...chats.chats.values()].sort(byActivity);
  return (
    <Stack sx={{ minHeight: 0, flex: 1, overflowY: "auto" }}>
      {chats.listError && (
        <Alert severity="error" sx={{ m: 1 }}>
          {chats.listError}
        </Alert>
      )}
      {chats.streamState === "offline" && chats.streamDetail && (
        <Alert severity="warning" sx={{ m: 1 }}>
          Live updates are reconnecting. {chats.streamDetail}
        </Alert>
      )}
      {listed.length === 0 && !chats.listError && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No chats yet. Start one with an agent.
        </Typography>
      )}
      <List dense disablePadding>
        {listed.map((chat) => (
          <ListItemButton
            key={chat.roomId}
            selected={chat.roomId === selected}
            onClick={() => onOpen(chat.roomId)}
            sx={{ borderRadius: "10px", mx: 1, my: 0.25 }}
          >
            <ListItemText
              primary={chatTitle(chat)}
              secondary={
                chat.lastMessage
                  ? `${chat.lastMessage.senderName}: ${chat.lastMessage.preview}`
                  : "No messages yet"
              }
              slotProps={{
                primary: { noWrap: true, fontWeight: chats.unread(chat.roomId) > 0 ? 600 : 500 },
                secondary: { noWrap: true },
              }}
            />
            <Badge badgeContent={chats.unread(chat.roomId)} color="primary" sx={{ ml: 1.5 }} />
          </ListItemButton>
        ))}
      </List>
    </Stack>
  );
});

/**
 * The agents the person may start a chat with, as the server decides it; null
 * on a server without group chats, which does not say, and checks each agent
 * only as the chat is made.
 */
async function candidates(): Promise<Set<string> | null> {
  try {
    return new Set(await webChatsClient.listAgentCandidates(null));
  } catch (caught) {
    if (caught instanceof ChatRequestError && caught.apiCode === "GROUP_CHATS_OFF") return null;
    throw caught;
  }
}

/** Picks an agent to start a direct chat with: one the server lets the viewer chat with. */
function NewChatDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (chat: ChatSummary) => void;
}) {
  const userId = useAuth().user?.id ?? null;
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgents(null);
    setError(null);
    let cancelled = false;
    Promise.all([candidates(), fetchAgents()])
      .then(([ids, all]) => {
        if (cancelled) return;
        if (all === null) throw new Error("The agents could not be listed.");
        const listed = ids === null ? all : all.filter((agent) => ids.has(agent.id));
        // The person's own agents first: those are the ones they can always chat with.
        const own = (agent: AgentSummary) => (agent.owner_id === userId ? 0 : 1);
        setAgents([...listed].sort((a, b) => own(a) - own(b)));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(webFailures.describe(caught, "The agents could not be listed.").headline);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const start = async (agent: AgentSummary) => {
    setBusy(agent.id);
    setError(null);
    try {
      const chat = await webChatsClient.createChat({
        agentIds: [agent.id],
        name: null,
        requestId: crypto.randomUUID(),
        greeting: null,
      });
      onCreated(chat);
    } catch (caught) {
      setError(webFailures.describe(caught, "The chat could not be started.").headline);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Chat with an agent</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        {agents === null && !error && (
          <Typography variant="body2" color="text.secondary">
            Loading agents…
          </Typography>
        )}
        {agents?.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            There are no agents you can chat with yet.
          </Typography>
        )}
        <List dense>
          {agents?.map((agent) => (
            <ListItemButton
              key={agent.id}
              disabled={busy !== null}
              onClick={() => void start(agent)}
              sx={{ borderRadius: "10px" }}
            >
              <ListItemText
                primary={agent.display_name ?? agent.name}
                secondary={busy === agent.id ? "Starting…" : agent.description || agent.name}
                slotProps={{ secondary: { noWrap: true } }}
              />
            </ListItemButton>
          ))}
        </List>
      </DialogContent>
    </Dialog>
  );
}

/** A room's name when it is not one of the person's chats, so its page still says which room it is. */
function useRoomName(roomId: string, known: boolean): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(null);
    if (known) return;
    let cancelled = false;
    void fetchRoom(roomId).then((room) => {
      if (!cancelled) setName(room?.name ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, known]);
  return name;
}

const ChatPane = observer(function ChatPane({ roomId }: { roomId: string }) {
  const { chats } = useChatHost();
  const chat = chats.chat(roomId);
  const roomName = useRoomName(roomId, chat !== undefined);
  return (
    <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <Box sx={{ px: 3, py: 1.5, borderBottom: "1px solid var(--sw-border)" }}>
        <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600 }}>
          {chat ? chatTitle(chat) : (roomName ?? "Chat")}
        </Typography>
        {chat && chat.channelType !== "direct" && (
          <Typography variant="caption" color="text.secondary" noWrap component="p">
            {chat.agents.map(chatAgentLabel).join(", ") || "No agents"}
          </Typography>
        )}
      </Box>
      {chat ? (
        <Box className={SHARED_UI_CLASS} sx={{ flex: 1, minHeight: 0 }}>
          <ChatPanel key={roomId} serverId={WEB_SERVER_ID} roomId={roomId} />
        </Box>
      ) : (
        <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 1.5, p: 4 }}>
          {/* The list is read once the feed is up; until then a chat may still be on it. */}
          {chats.userId === null && !chats.listError ? (
            <Typography color="text.secondary">Loading the chat…</Typography>
          ) : (
            <>
              <Typography sx={{ fontWeight: 600 }}>This room isn't one of your chats</Typography>
              <Typography color="text.secondary" sx={{ maxWidth: 420, textAlign: "center" }}>
                Being able to see a room doesn't let you read its conversation. Ask its owner to
                add you.
              </Typography>
              <Button component={RouterLink} to={`/rooms/${encodeURIComponent(roomId)}`}>
                Open the room's page
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
});

function Chats() {
  const { roomId } = useParams<{ roomId?: string }>();
  const navigate = useNavigate();
  const { chats } = useChatHost();
  const [picking, setPicking] = useState(false);
  const open = (id: string) => navigate(`/chats/${encodeURIComponent(id)}`);

  return (
    <Box sx={{ m: -4, flex: 1, minHeight: 0, display: "flex" }}>
      <Stack
        sx={{
          width: 300,
          flexShrink: 0,
          minHeight: 0,
          borderRight: "1px solid var(--sw-border)",
        }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 2 }}>
          <Typography variant="h6">Chats</Typography>
          <Button size="small" startIcon={<AddOutlined />} onClick={() => setPicking(true)}>
            New chat
          </Button>
        </Stack>
        <ChatList selected={roomId ?? null} onOpen={open} />
      </Stack>
      {roomId ? (
        <ChatPane roomId={roomId} />
      ) : (
        <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 1, p: 4 }}>
          <ChatBubbleOutlineOutlined sx={{ fontSize: 40, opacity: 0.4 }} />
          <Typography color="text.secondary">Pick a chat, or start one with an agent.</Typography>
        </Stack>
      )}
      <NewChatDialog
        open={picking}
        onClose={() => setPicking(false)}
        onCreated={(chat) => {
          chats.add(WEB_SERVER_ID, chat);
          setPicking(false);
          open(chat.roomId);
        }}
      />
    </Box>
  );
}

/** The person's chats with agents, and the rooms they are in with agents, opened and answered here. */
export default function ChatsPage() {
  if (!useOptionalChatHost())
    return (
      <Typography variant="body2" color="text.secondary">
        Loading your chats…
      </Typography>
    );
  return <Chats />;
}
