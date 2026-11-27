import { useQuery } from "@tanstack/react-query";
import { AgentsClient } from "@switch-console/chat-ui/client/agents-client";
import { gatewayFetch } from "./gatewayFetch";
import { managementError } from "./management";

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
    // Picked from the person's managed agents rather than asked for by id: one
    // Switch does not run is absent from the list, where by id it is a 404.
    queryFn: async () =>
      (await agentsClient.listManagedAgents()).find((managed) => managed.agent_id === agentId) ?? null,
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
