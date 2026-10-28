import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { serverAvailability } from '@renderer/features/switch-servers/server-availability';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { events, rpc } from '@renderer/lib/ipc';
import { chatActivityChannel, chatMessageChannel } from '@shared/core/chats/chatEvents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { agentMigrationChannel } from '@shared/events/agentMigrationEvents';
import { MANAGED_AGENTS_KEY } from './use-managed-agents-key';
import { useUserChangesLive } from './use-user-changes';

export { MANAGED_AGENTS_KEY };

/**
 * How often the list is read again on its own, against a server that does not
 * push changes (`useUserChangesLive`). One that does tells Console when to
 * read it, so it is read only every `PUSHED_RECONCILE_MS`. Changes made from
 * this Console (an edit, a new agent, a move) refresh it straight away either
 * way, and react-query reads it again when the window regains focus.
 */
const MANAGED_AGENTS_REFRESH_MS = 30_000;
/** The machines list's polling rate against a server that does not push changes. */
const MACHINES_REFRESH_MS = 15_000;
/**
 * How often a list is read again while the server pushes changes. A notice
 * can be lost without the socket closing: the pod that made the change died
 * before it published it, or an older pod made it during a rolling deploy and
 * publishes nothing. Nothing on the server can tell, so this bounds how long a
 * list can stay stale.
 */
const PUSHED_RECONCILE_MS = 5 * 60_000;

/**
 * The polling rate for a list, given whether the server pushes changes. A read
 * that failed is tried again at the polling rate even while the socket is up,
 * since no notice may come to retry it.
 */
export function refreshEvery(pollMs: number, pushed: boolean, failed: boolean): number {
  return pushed && !failed ? PUSHED_RECONCILE_MS : pollMs;
}

/** How soon after an agent's activity in a chat the list is read again. */
const AGENT_ACTIVITY_REFRESH_MS = 1_500;

/**
 * How often to ask again while the server's flags say it runs agent management
 * but it answered that it does not, as a server still starting up can.
 */
const MANAGEMENT_UNAVAILABLE_RETRY_MS = 3_000;

/**
 * The signed-in user's managed agents on the server, as the server holds them,
 * whatever machine each runs on. `null` means the server runs no agent
 * management.
 */
export function useManagedAgents(serverId: string | null) {
  const queryClient = useQueryClient();
  // Not asked while a server this Console runs is down: the call can only
  // fail, and the list it last gave is the one worth showing meanwhile.
  const signedIn =
    serverId !== null &&
    switchServersStore.isConnected(serverId) &&
    serverAvailability(serverId) !== 'dormant';
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  // The list is the workspace's, not the server's: switching workspace on the
  // same server has to read it again rather than show the last one.
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const pushed = useUserChangesLive(signedIn ? serverId : null);
  const managementOn = useFeatureFlags(serverId).agent_management;
  useEffect(
    () =>
      events.on(agentMigrationChannel, (event) => {
        if (event.operation === null)
          void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
      }),
    [queryClient, serverId]
  );
  // An agent speaking or working in a chat is when the list most likely moved
  // without this Console doing it: the agent is up (its status), or it just
  // made an agent for its owner (switch-buddy). Read again then, at most once
  // a few seconds, rather than at the next half-minute.
  useEffect(() => {
    if (serverId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
      }, AGENT_ACTIVITY_REFRESH_MS);
    };
    const offMessage = events.on(chatMessageChannel, (event) => {
      if (event.serverId === serverId && event.message.sender.kind === 'agent') soon();
    });
    const offActivity = events.on(chatActivityChannel, (event) => {
      if (event.serverId === serverId) soon();
    });
    return () => {
      offMessage();
      offActivity();
      if (timer !== null) clearTimeout(timer);
    };
  }, [queryClient, serverId]);
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, workspaceId, user?.id ?? null],
    queryFn: () => rpc.managedAgents.list(serverId!),
    enabled: signedIn,
    // Null is not final while the flags say otherwise: without asking again,
    // a server that answered so while it started would hide every agent,
    // switch-buddy included, until something remounted the list.
    refetchInterval: (query) =>
      query.state.data !== null
        ? refreshEvery(MANAGED_AGENTS_REFRESH_MS, pushed, query.state.status === 'error')
        : managementOn
          ? MANAGEMENT_UNAVAILABLE_RETRY_MS
          : false,
    retry: false,
  });
}

/** The signed-in user's machines on the server, with what each reported; null without agent management. */
export function useOwnedMachines(serverId: string) {
  const pushed = useUserChangesLive(serverId);
  return useQuery({
    queryKey: [
      MANAGED_AGENTS_KEY,
      serverId,
      'machines',
      workspacesStore.idOnServerInScope(serverId),
    ],
    queryFn: () => rpc.managedAgents.machines(serverId),
    refetchInterval: (query) =>
      refreshEvery(MACHINES_REFRESH_MS, pushed, query.state.status === 'error'),
  });
}

/** Whether the agent's machine is this computer, as its owner's machine list says. */
export function useRunsOnThisComputer(agent: ManagedAgentView): boolean {
  const machines = useOwnedMachines(agent.serverId);
  return (
    machines.data?.find((machine) => machine.id === agent.machine?.id)?.local?.kind ===
    'this-computer'
  );
}

/**
 * How an agent's machine is named to the person: "This computer" for this
 * one, otherwise the machine's own name, which for a laptop is its hostname.
 * Null when the agent has no machine.
 */
export function useMachineLabel(agent: ManagedAgentView): string | null {
  const thisComputer = useRunsOnThisComputer(agent);
  if (!agent.machine) return null;
  return thisComputer ? 'This computer' : agent.machine.name;
}

/** The owner's machines on the server, with what each last reported. Null without agent management. */
export function useManagedMachines(serverId: string) {
  const pushed = useUserChangesLive(serverId);
  return useQuery({
    queryKey: [
      MANAGED_AGENTS_KEY,
      serverId,
      'machines',
      workspacesStore.idOnServerInScope(serverId),
    ],
    queryFn: () => rpc.managedAgents.machines(serverId),
    // The same rate as `useOwnedMachines`: they share the key, so the faster
    // of two different intervals would win for both.
    refetchInterval: (query) =>
      query.state.data
        ? refreshEvery(MACHINES_REFRESH_MS, pushed, query.state.status === 'error')
        : false,
    retry: false,
  });
}

/** Each provider's advanced configuration fields, as the server checks a definition against them. */
export function useAdvancedConfigSchema(serverId: string | null) {
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'advanced-config-schema'],
    queryFn: () => rpc.managedAgents.advancedConfigSchema(serverId!),
    enabled: serverId !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Without the agents the server manages. An agent moved to managed from here
 * keeps a row in Console, but the server is what runs it now, so it is shown
 * the way every managed agent is, from the server, rather than twice or as a
 * Console agent with a room watcher that no longer runs here.
 */
export function withoutManaged<T extends { switchAgentId: string | null }>(
  agents: T[],
  managed: ManagedAgentView[] | null | undefined
): T[] {
  if (!managed) return agents;
  const ids = new Set(managed.map((agent) => agent.agentId));
  return agents.filter((agent) => agent.switchAgentId === null || !ids.has(agent.switchAgentId));
}
