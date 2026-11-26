import { Navigate, useParams } from "react-router";
import { useAuth } from "../../data/AuthContext";
import AgentDetailPage from "./AgentDetailPage";

export default function AgentDetailRedirect() {
  const { agentId } = useParams<{ agentId: string }>();
  const { capabilities } = useAuth();

  if (capabilities.features.gateway_chats && agentId) {
    return <Navigate replace to={`/chats/agents/${encodeURIComponent(agentId)}`} />;
  }

  return <AgentDetailPage />;
}
