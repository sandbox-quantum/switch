import {
  CloudRelayClient,
  CloudRelayError,
  RELAY_TIMEOUT_MS,
} from '@switch-console/agent-providers';
import type { Attachment, Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import {
  AgentManagementUnavailableError,
  fetchManagedAgent,
  fetchManagedAgents,
  fetchManagementControllers,
  GatewayError,
  gatewayFetch,
  gatewayRequest,
  type ManagedAgent,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { requireSwitchCloudEnabled } from '@main/core/switch-servers/switch-cloud';
import { withServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { KV } from '@main/db/kv';
import {
  type CloudAgent,
  cloudAgentKey,
  type CloudAgentTarget,
  type CloudMachine,
  cloudMachineSchema,
  type CloudOperationOutcome,
  type CloudRelayProblem,
  type CloudSessions,
  parseCloudAgentKey,
} from '@shared/core/cloud-agents/cloud-agents';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Console's reach into a cloud agent, through its Switch server.
 *
 * A sidecar is reached over SSH on its control port; a cloud machine accepts
 * no connection, so the same control messages go through the server's relay
 * for the agent: the control routes of the managed agent its cloud machine's
 * controller (kind `ec2`) runs. One relay client per agent, made on first use
 * and again after it closes. Transcripts stay on the machine: every snapshot,
 * list and event is asked of it through the relay.
 */

export function isCloudAgent(agentId: string): boolean {
  return parseCloudAgentKey(agentId) !== null;
}

function targetOf(agentId: string): CloudAgentTarget {
  const key = parseCloudAgentKey(agentId);
  if (!key) throw new Error(`${agentId} is not a cloud agent.`);
  return key;
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Where Switch relays for a cloud agent, relative to the gateway. */
export function cloudRelayBasePath(target: CloudAgentTarget): string {
  if (!AGENT_ID.test(target.agentId))
    throw new Error(`${JSON.stringify(target.agentId)} is not a Switch agent id.`);
  return `/management/agents/${target.agentId}/control`;
}

async function requireCloudServer(serverId: string): Promise<void> {
  requireSwitchCloudEnabled();
  if (!(await getServer(serverId)))
    throw new Error('The Switch server for this cloud agent was removed.');
}

/**
 * Run `fn` against the cloud agent's server with its workspace's tenant
 * selected: agents and machines belong to a tenant, so a
 * call that went out under another one would answer for that one instead.
 * One lease per request, never around a wait, so a workspace switch is not
 * held up by a long poll.
 */
async function onCloudServer<T>(
  serverId: string,
  fn: (server: SwitchServer) => Promise<T>
): Promise<T> {
  await requireCloudServer(serverId);
  return withServerWorkspaceSession(serverId, fn);
}

function machinePath(machineId: string, rest = ''): string {
  return `/hosted-machines/${encodeURIComponent(machineId)}${rest}`;
}

/**
 * A relay client for a managed agent's sessions, through its server's
 * gateway with the server's workspace selected per request. Shared by cloud
 * agents and agents on any other controller; the caller checks the server.
 */
export function relayClientFor(target: CloudAgentTarget): CloudRelayClient {
  return new CloudRelayClient(
    (path, init) =>
      withServerWorkspaceSession(target.serverId, (server) =>
        gatewayRequest(server, path, {
          authenticated: true,
          method: init.method,
          body: init.body,
          signal: init.signal,
        })
      ),
    cloudRelayBasePath(target),
    { retryMs: 20_000, timeoutMs: RELAY_TIMEOUT_MS }
  );
}

/** Raise when the server is no longer registered. */
export async function requireRegisteredServer(serverId: string): Promise<void> {
  if (!(await getServer(serverId)))
    throw new Error('The Switch server for this agent was removed.');
}

const clients = new Map<string, CloudRelayClient>();

/**
 * The sessions last read from each cloud agent, by agent key, kept
 * across restarts: while its machine is stopped, asleep or waking they stay
 * listed beside why, since opening one is how its user wakes it.
 */
const lastSessions = new KV<Record<string, Session[]>>('cloud-sessions');
const KEEPS_LAST_SESSIONS = new Set(['machine_stopped', 'worker_sleeping', 'worker_waking']);

/** The relay client for this cloud agent, made if there is none. */
export async function cloudControl(agentId: string): Promise<CloudRelayClient> {
  requireSwitchCloudEnabled();
  const existing = clients.get(agentId);
  if (existing && !existing.isClosed) return existing;
  const target = targetOf(agentId);
  const { serverId } = target;
  await requireCloudServer(serverId);
  const client = relayClientFor(target);
  client.onClose(() => {
    if (clients.get(agentId) === client) clients.delete(agentId);
  });
  clients.set(agentId, client);
  return client;
}

/**
 * The caller's cloud machines, or null when the server has no cloud machines
 * at all: a Core without them answers the route with 404.
 */
export async function listCloudMachines(server: SwitchServer): Promise<CloudMachine[] | null> {
  let response: Response;
  try {
    response = await gatewayFetch(server, '/hosted-machines', { authenticated: true });
  } catch (error) {
    if (error instanceof GatewayError && error.kind === 'http' && error.status === 404) return null;
    throw error;
  }
  return z.object({ machines: z.array(cloudMachineSchema) }).parse(await response.json()).machines;
}

/** The caller's cloud machines, or null when the server has no cloud agents. */
export async function listServerCloudMachines(serverId: string): Promise<CloudMachine[] | null> {
  return onCloudServer(serverId, listCloudMachines);
}

/**
 * The caller's managed agents that a cloud machine's controller runs, by
 * agent id: those placed on one of their `ec2` controllers. Empty when the
 * server has no agent management or the caller has no cloud machine
 * controller.
 */
export async function listControllerCloudAgents(
  server: SwitchServer
): Promise<Map<string, ManagedAgent & { controllerId: string }>> {
  let controllers;
  try {
    controllers = await fetchManagementControllers(server);
  } catch (error) {
    if (error instanceof AgentManagementUnavailableError) return new Map();
    throw error;
  }
  const cloud = new Set(
    controllers.filter((controller) => controller.kind === 'ec2').map((each) => each.id)
  );
  if (cloud.size === 0) return new Map();
  const placed = new Map<string, ManagedAgent & { controllerId: string }>();
  for (const agent of await fetchManagedAgents(server))
    if (agent.controllerId !== null && cloud.has(agent.controllerId))
      placed.set(agent.agentId, { ...agent, controllerId: agent.controllerId });
  return placed;
}

/**
 * Why a cloud agent cannot be asked, or null when it can. The machine says
 * first; the agent's own state is the managed agent's, which its controller
 * reports.
 */
function cloudAgentProblem(
  machine: CloudMachine | null,
  agent: ManagedAgent
): CloudRelayProblem | null {
  if (machine?.state === 'error')
    return {
      code: 'machine_error',
      message: machine.error ?? 'The cloud machine is in error.',
      wakeAvailable: false,
    };
  if (machine?.desired_state === 'stopped' && machine.stop_reason === 'owner')
    return {
      code: 'machine_stopped',
      message: 'The owner stopped the cloud machine.',
      wakeAvailable: false,
    };
  if (agent.desiredState === 'stopped')
    return { code: 'agent_stopped', message: 'The agent is stopped.', wakeAvailable: false };
  if (machine?.sleeping)
    return {
      code: 'worker_sleeping',
      message: 'The cloud machine is asleep.',
      wakeAvailable: true,
    };
  if (
    machine?.desired_state === 'running' &&
    ['queued', 'provisioning', 'stopping', 'stopped', 'retained'].includes(machine.state)
  )
    return {
      code: 'worker_waking',
      message: 'The cloud machine is starting.',
      wakeAvailable: false,
    };
  if (agent.status?.process === 'crashed' || agent.status?.process === 'failed')
    return {
      code: 'agent_crashed',
      message: agent.status.detail ?? 'The agent crashed.',
      wakeAvailable: false,
    };
  return null;
}

/**
 * The server's cloud agents, read from the managed agents its cloud machine
 * controllers run and the machine list, or null when the server has no cloud
 * agents. An agent that cannot be asked says why; the sessions of one that can
 * are asked of its machine by `listCloudSessions`, only for the agents being
 * looked at.
 */
export async function listCloudAgents(serverId: string): Promise<CloudAgent[] | null> {
  const machines = await onCloudServer(serverId, listCloudMachines);
  if (machines === null) return null;
  const placed = [...(await onCloudServer(serverId, listControllerCloudAgents)).values()];
  const stored = await lastSessions.getAll();
  const keys = new Set(placed.map((agent) => cloudAgentKey(serverId, agent.agentId)));
  for (const key of Object.keys(stored))
    if (parseCloudAgentKey(key)?.serverId === serverId && !keys.has(key))
      await lastSessions.del(key);
  return placed.map((agent): CloudAgent => {
    const machine = machines.find((each) => each.controller_id === agent.controllerId) ?? null;
    const key = cloudAgentKey(serverId, agent.agentId);
    const problem = cloudAgentProblem(machine, agent);
    return {
      key,
      agentId: agent.agentId,
      name: agent.name,
      provider: agent.provider,
      machine,
      controller: {
        controllerId: agent.controllerId,
        desiredState: agent.desiredState,
        process: agent.status?.process ?? null,
        detail: agent.status?.detail ?? null,
      },
      sessions: problem && KEEPS_LAST_SESSIONS.has(problem.code) ? (stored[key] ?? null) : null,
      problem,
    };
  });
}

/**
 * A cloud agent's sessions, asked of its machine over the relay. An agent that
 * cannot be asked is reported with the relay's code rather than as no sessions,
 * beside the sessions last read while its machine is down.
 */
export async function listCloudSessions(agentId: string): Promise<CloudSessions> {
  let sessions: Session[];
  try {
    sessions = await (await cloudControl(agentId)).list();
  } catch (error) {
    const problem: CloudRelayProblem =
      error instanceof CloudRelayError
        ? {
            code: error.relayCode,
            message: error.message,
            wakeAvailable: error.wakeAvailable,
          }
        : {
            code: 'failed',
            message: error instanceof Error ? error.message : String(error),
            wakeAvailable: false,
          };
    return {
      sessions: KEEPS_LAST_SESSIONS.has(problem.code) ? await lastSessions.get(agentId) : null,
      problem,
    };
  }
  await lastSessions.set(agentId, sessions);
  return { sessions, problem: null };
}

/**
 * Start the machine a sleeping cloud agent runs on. Only a machine that went to
 * sleep idle is woken: one its owner stopped is started from its card. A
 * machine already asked to run is returned as it is, so a second wake does not
 * bump its revision, and a wake that loses the revision race to another one is
 * the machine waking.
 */
export async function wakeCloudAgent(agentId: string): Promise<CloudMachine> {
  const { serverId, agentId: switchAgentId } = targetOf(agentId);
  const machineId = await machineOfAgent(serverId, switchAgentId);
  const read = async () =>
    cloudMachineSchema.parse(
      await onCloudServer(serverId, async (server) =>
        (await gatewayFetch(server, machinePath(machineId), { authenticated: true })).json()
      )
    );
  const machine = await read();
  if (machine.desired_state === 'running') return machine;
  if (!machine.sleeping)
    throw new Error(
      machine.desired_state === 'stopped' && machine.stop_reason === 'owner'
        ? 'The owner stopped the cloud machine, so a message does not wake it. Start the machine in Your Agents.'
        : `The cloud machine is ${machine.desired_state}, so it cannot be woken.`
    );
  try {
    return z.object({ machine: cloudMachineSchema }).parse(
      await onCloudServer(serverId, async (server) =>
        (
          await gatewayFetch(server, machinePath(machineId, '/lifecycle'), {
            authenticated: true,
            method: 'POST',
            body: { action: 'start', revision: machine.revision },
          })
        ).json()
      )
    ).machine;
  } catch (error) {
    if (!(error instanceof GatewayError && error.kind === 'http' && error.status === 409))
      throw error;
    const now = await read();
    if (now.desired_state === 'running') return now;
    throw error;
  }
}

/**
 * The cloud machine a cloud agent runs on: the one whose controller the
 * managed agent is placed on.
 */
async function machineOfAgent(serverId: string, agentId: string): Promise<string> {
  const agent = await onCloudServer(serverId, (server) => fetchManagedAgent(server, agentId));
  if (agent === null)
    throw new Error(`The cloud agent ${agentId} is not a managed agent on its Switch server.`);
  if (agent.controllerId === null)
    throw new Error(`The cloud agent ${agent.name} is not placed on a cloud machine.`);
  const controllerId = agent.controllerId;
  const machine = (await onCloudServer(serverId, listCloudMachines))?.find(
    (each) => each.controller_id === controllerId
  );
  if (!machine)
    throw new Error(
      `The cloud agent ${agent.name} has no cloud machine on its Switch server, so there is no machine to start.`
    );
  return machine.machine_id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start a new session of a cloud agent (`start`) or run an existing one again
 * (`restart`), relayed to the agent's host as an `ensure` naming only the
 * session: the host builds the session from the agent's own configuration. A
 * refusal Switch or the controller answered sent nothing on; anything else may
 * have acted, so its outcome is unknown and asking again is safe, since a
 * start of a session that exists goes on with it.
 */
export async function runCloudSessionOperation(
  agentId: string,
  sessionId: string,
  action: 'start' | 'restart'
): Promise<CloudOperationOutcome> {
  try {
    await (
      await cloudControl(agentId)
    ).ensure({
      sessionId,
      resuming: action === 'restart',
      restart: action === 'restart',
      startSource: action === 'start' ? 'user' : null,
    });
    return { state: 'applied' };
  } catch (error) {
    if (error instanceof CloudRelayError && error.status < 500)
      return { state: 'failed', message: error.message, code: error.relayCode };
    return {
      state: 'unknown',
      message: `The cloud machine's controller did not confirm the session ${action}: ${errorMessage(error)}`,
    };
  }
}

/** Stage a file on the session's machine for the next message to name. */
export async function uploadCloudAttachment(
  agentId: string,
  sessionId: string,
  file: { name: string; mimeType: string; data: string }
): Promise<Attachment> {
  return (await cloudControl(agentId)).uploadAttachment(sessionId, {
    name: file.name,
    mimeType: file.mimeType,
    data: Buffer.from(file.data, 'base64'),
  });
}
