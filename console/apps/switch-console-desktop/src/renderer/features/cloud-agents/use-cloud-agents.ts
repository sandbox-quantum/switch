import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { type CloudAgent, parseCloudAgentKey } from '@shared/core/cloud-agents/cloud-agents';

/**
 * Whether the server's workspace on screen went unasked because Switch Console
 * is not signed in to the server: the sidebar already says to sign in.
 */
export function serverNotSignedIn(serverId: string | null): boolean {
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  return switchRoomsStore.workspacesNotSignedIn.some((workspace) => workspace.id === workspaceId);
}

/**
 * The server's cloud agents, from its launch list; no worker is asked. Not
 * asked while signed out: the sidebar already says to sign in.
 *
 * `null` means the server has no cloud agents. It is not asked again until its
 * session or declared version changes, which is when it may have gained them.
 */
export function useCloudAgents(serverId: string | null) {
  const signedOut = serverNotSignedIn(serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  return useQuery({
    queryKey: ['cloud-agents', serverId, user?.id ?? null, user?.server?.version ?? null],
    queryFn: () => rpc.sdkHost.cloudAgents(serverId!),
    enabled: serverId !== null && !signedOut,
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}

/**
 * The caller's cloud machines on the server, asked the way `useCloudAgents`
 * asks for launches. `null` means the server has no cloud agents. Under
 * `['cloud-agents']`, so every refresh of the list refreshes this too.
 */
export function useCloudMachines(serverId: string | null) {
  const signedOut = serverNotSignedIn(serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  return useQuery({
    queryKey: ['cloud-agents', serverId, 'machines', user?.id ?? null],
    queryFn: () => rpc.sdkHost.cloudMachines(serverId!),
    enabled: serverId !== null && !signedOut,
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}

/**
 * The agent with its worker's sessions, asked over the relay only while
 * `watched` and while the window is visible, since each ask is a round trip
 * through the server. A launch that says its worker cannot be asked is not,
 * and carries the sessions last read from it while its machine is down.
 * Under `['cloud-agents']`, so every refresh of the list refreshes this too.
 */
export function useCloudAgentSessions(agent: CloudAgent, watched: boolean): CloudAgent;
export function useCloudAgentSessions(
  agent: CloudAgent | undefined,
  watched: boolean
): CloudAgent | undefined;
export function useCloudAgentSessions(
  agent: CloudAgent | undefined,
  watched: boolean
): CloudAgent | undefined {
  const listed = useQuery({
    queryKey: [
      'cloud-agents',
      parseCloudAgentKey(agent?.key ?? '')?.serverId,
      'sessions',
      agent?.key,
    ],
    queryFn: () => rpc.sdkHost.cloudSessions(agent!.key),
    enabled: watched && agent !== undefined && !agent.problem,
    refetchInterval: 5000,
    retry: false,
  });
  if (!agent || agent.problem) return agent;
  if (listed.error)
    return {
      ...agent,
      sessions: null,
      problem: { code: 'failed', message: String(listed.error), wakeAvailable: false },
    };
  return listed.data ? { ...agent, ...listed.data } : agent;
}

/** Start the machine a sleeping agent runs on, then look again. */
export function useCloudWake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentKey: string) => rpc.sdkHost.cloudWake(agentKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cloud-agents'] }),
  });
}

/** Start or retry the machine an agent runs on, at the revision it was read at. */
function useCloudMachineAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agent, action }: { agent: CloudAgent; action: 'start' | 'retry' }) => {
      const key = parseCloudAgentKey(agent.key);
      if (!key || !agent.machine) throw new Error(`${agent.launch.name} has no cloud machine.`);
      return rpc.switchServers.cloudMachineLifecycle(
        key.serverId,
        agent.machine.machine_id,
        action,
        agent.machine.revision
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cloud-agents'] }),
  });
}

export type CloudProblemAction = {
  label: string;
  pending: boolean;
  error: string | null;
  run: () => void;
};

/**
 * What the user can do about why an agent's worker cannot be asked: wake a
 * sleeping machine (only where `wake`, since a composer wakes it by sending),
 * start one its owner stopped, or retry one in error.
 */
export function useCloudProblemAction(agent: CloudAgent, wake: boolean): CloudProblemAction | null {
  const waking = useCloudWake();
  const machineAction = useCloudMachineAction();
  const failed = (error: Error | null, what: string) =>
    error ? `Could not ${what}: ${String(error)}` : null;
  const problem = agent.problem;
  if (wake && problem?.code === 'worker_sleeping' && problem.wakeAvailable)
    return {
      label: waking.isPending ? 'Waking…' : 'Wake',
      pending: waking.isPending,
      error: failed(waking.error, 'wake the machine'),
      run: () => waking.mutate(agent.key),
    };
  if (problem?.code === 'machine_stopped' && agent.machine)
    return {
      label: machineAction.isPending ? 'Starting…' : 'Start machine',
      pending: machineAction.isPending,
      error: failed(machineAction.error, 'start the machine'),
      run: () => machineAction.mutate({ agent, action: 'start' }),
    };
  if (
    problem?.code === 'machine_error' &&
    agent.machine &&
    agent.machine.error_code !== 'machine_needs_attention'
  )
    return {
      label: machineAction.isPending ? 'Retrying…' : 'Retry machine',
      pending: machineAction.isPending,
      error: failed(machineAction.error, 'retry the machine'),
      run: () => machineAction.mutate({ agent, action: 'retry' }),
    };
  return null;
}
