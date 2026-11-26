import { useQuery } from "@tanstack/react-query";
import { AgentsClient } from "@switch-console/chat-ui/client/agents-client";
import { gatewayFetch } from "./gatewayFetch";
import { ManagementApiError, managementError } from "./management";

const agentsClient = new AgentsClient({
  call: async (path, request = {}) => {
    const response = await gatewayFetch(`/gateway${path}`, {
      method: request.method ?? "GET",
      body: request.body ? JSON.stringify(request.body) : undefined,
      headers: request.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (!response.ok) throw await managementError(response);
    return response;
  },
});

export function useManagedAgent(agentId: string | null) {
  return useQuery({
    queryKey: ["managedAgent", agentId],
    queryFn: async () => {
      if (!agentId) return null;
      try {
        return await agentsClient.getManagedAgent(agentId);
      } catch (error) {
        // Switch does not run this agent: there is nothing to manage, which is not a failure.
        if (error instanceof ManagementApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: agentId !== null,
    staleTime: 5000,
  });
}

export function useManagedAgentMachines() {
  return useQuery({
    queryKey: ["managedAgentMachines"],
    queryFn: () => agentsClient.listMachines(),
    staleTime: 10000,
  });
}

export { agentsClient };
