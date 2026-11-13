import ForumOutlined from "@mui/icons-material/ForumOutlined";
import { Alert, Button, Snackbar } from "@mui/material";
import { useOptionalChatHost } from "@switch-console/chat-ui/host";
import { useState } from "react";
import { useNavigate } from "react-router";
import { WEB_SERVER_ID } from "./webServer";

/**
 * Opens the person's direct chat with an agent, starting one if they have
 * none. Shown only where the dashboard has chats.
 */
export default function ChatWithAgentButton({ agentId }: { agentId: string }) {
  const host = useOptionalChatHost();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!host) return null;

  const openChat = (roomId: string) => navigate(`/chats/${encodeURIComponent(roomId)}`);
  const start = async () => {
    const existing = host.chats
      .chatsOfAgent(agentId)
      .find((chat) => chat.channelType === "direct" && chat.agents.length === 1);
    if (existing) {
      openChat(existing.roomId);
      return;
    }
    setBusy(true);
    // Loaded only when asked: the chat client is not part of every page.
    const { webChatsClient, webFailures } = await import("./webChatClient");
    try {
      const chat = await webChatsClient.createChat({
        agentIds: [agentId],
        name: null,
        requestId: crypto.randomUUID(),
        greeting: null,
      });
      host.chats.add(WEB_SERVER_ID, chat);
      openChat(chat.roomId);
    } catch (caught) {
      setError(webFailures.describe(caught, "The chat could not be started.").headline);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<ForumOutlined />}
        disabled={busy}
        onClick={() => void start()}
      >
        Chat
      </Button>
      <Snackbar open={error !== null} autoHideDuration={8000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
