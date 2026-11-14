import ForumOutlined from "@mui/icons-material/ForumOutlined";
import { Button } from "@mui/material";
import { useOptionalChatHost } from "@switch-console/chat-ui/host";
import { observer } from "mobx-react-lite";
import { useNavigate } from "react-router";

/** Opens a room's conversation on the Chats page, when the room is one of the person's chats. */
export default observer(function OpenChatButton({ roomId }: { roomId: string }) {
  const host = useOptionalChatHost();
  const navigate = useNavigate();
  if (!host?.chats.chat(roomId)) return null;
  return (
    <Button
      size="small"
      variant="outlined"
      startIcon={<ForumOutlined />}
      onClick={() => navigate(`/chats/${encodeURIComponent(roomId)}`)}
    >
      Open chat
    </Button>
  );
});
