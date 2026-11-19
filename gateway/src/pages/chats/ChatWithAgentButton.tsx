import ForumOutlined from "@mui/icons-material/ForumOutlined";
import { Button } from "@mui/material";
import { useOptionalChatHost } from "@switch-console/chat-ui/host";
import { useNavigate } from "react-router";

/** Opens the agent's page on the Chats page, with its direct chats. Shown only where the dashboard has chats. */
export default function ChatWithAgentButton({ agentId }: { agentId: string }) {
  const host = useOptionalChatHost();
  const navigate = useNavigate();
  if (!host) return null;
  return (
    <Button
      size="small"
      variant="outlined"
      startIcon={<ForumOutlined />}
      onClick={() => navigate(`/chats/agents/${encodeURIComponent(agentId)}`)}
    >
      Chat
    </Button>
  );
}
