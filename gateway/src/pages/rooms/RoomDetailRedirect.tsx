import { Navigate, useParams } from "react-router";
import { useAuth } from "../../data/AuthContext";
import RoomDetailPage from "./RoomDetailPage";

export default function RoomDetailRedirect() {
  const { roomId } = useParams<{ roomId: string }>();
  const { capabilities } = useAuth();

  if (capabilities.features.gateway_chats && roomId) {
    return <Navigate replace to={`/chats/rooms/${encodeURIComponent(roomId)}`} />;
  }

  return <RoomDetailPage />;
}
