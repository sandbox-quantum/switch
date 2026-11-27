import type { Capabilities } from "./capabilities";

export function agentPath(agentId: string, capabilities: Capabilities): string {
  if (capabilities.features.gateway_chats) {
    return `/chats/agents/${encodeURIComponent(agentId)}`;
  }
  return `/agents/${encodeURIComponent(agentId)}`;
}
