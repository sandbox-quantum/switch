import { setTimeout as delay } from 'node:timers/promises';
import {
  CloudRelayClient,
  CloudRelayError,
  RELAY_TIMEOUT_MS,
} from '@switch-console/agent-providers';
import type { Attachment, Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import {
  GatewayError,
  gatewayFetch,
  gatewayRequest,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { withServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { KV } from '@main/db/kv';
import {
  type CloudAgent,
  cloudAgentKey,
  cloudAgentPhase,
  type CloudLaunch,
  cloudLaunchSchema,
  type CloudMachine,
  cloudMachineSchema,
  type CloudOperation,
  type CloudOperationOutcome,
  cloudOperationSchema,
  type CloudRelayProblem,
  type CloudSessions,
  parseCloudAgentKey,
} from '@shared/core/cloud-agents/cloud-agents';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Console's reach into a cloud agent's worker, through its Switch server.
 *
 * A sidecar is reached over SSH on its control port; a cloud worker accepts no
 * connection, so the same control messages go through the server's relay for
 * the launch. One relay client per launch, made on first use and again after
 * it closes. Transcripts stay on the worker: every snapshot, list and event
 * is asked of it through the relay.
 */

export function isCloudAgent(agentId: string): boolean {
  return parseCloudAgentKey(agentId) !== null;
}

function launchOf(agentId: string): { serverId: string; requestId: string } {
  const key = parseCloudAgentKey(agentId);
  if (!key) throw new Error(`${agentId} is not a cloud agent.`);
  return key;
}

async function requireCloudServer(serverId: string): Promise<void> {
  if (!(await getServer(serverId)))
    throw new Error('The Switch server for this cloud agent was removed.');
}

/**
 * Run `fn` against the cloud agent's server with its workspace's tenant
 * selected: launches, machines and their operations belong to a tenant, so a
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

function launchPath(requestId: string, rest = ''): string {
  return `/hosted-launches/${encodeURIComponent(requestId)}${rest}`;
}

function machinePath(machineId: string, rest = ''): string {
  return `/hosted-machines/${encodeURIComponent(machineId)}${rest}`;
}

const clients = new Map<string, CloudRelayClient>();

/**
 * The sessions last read from each cloud agent's worker, by agent key, kept
 * across restarts: while its machine is stopped, asleep or waking they stay
 * listed beside why, since opening one is how its user wakes it.
 */
const lastSessions = new KV<Record<string, Session[]>>('cloud-sessions');
const KEEPS_LAST_SESSIONS = new Set(['machine_stopped', 'worker_sleeping', 'worker_waking']);

/** The relay client for this cloud agent's worker, made if there is none. */
export async function cloudControl(agentId: string): Promise<CloudRelayClient> {
  const existing = clients.get(agentId);
  if (existing && !existing.isClosed) return existing;
  const { serverId, requestId } = launchOf(agentId);
  await requireCloudServer(serverId);
  const client = new CloudRelayClient(
    (path, init) =>
      withServerWorkspaceSession(serverId, (server) =>
        gatewayRequest(server, launchPath(requestId, path), {
          authenticated: true,
          method: init.method,
          body: init.body,
          signal: init.signal,
        })
      ),
    { retryMs: 20_000, timeoutMs: RELAY_TIMEOUT_MS }
  );
  client.onClose(() => {
    if (clients.get(agentId) === client) clients.delete(agentId);
  });
  clients.set(agentId, client);
  return client;
}

/**
 * The server's launches, or null when it has no launch list at all: a Core
 * without cloud agents answers the route with 404.
 */
export async function listCloudLaunches(server: SwitchServer): Promise<CloudLaunch[] | null> {
  let response: Response;
  try {
    response = await gatewayFetch(server, '/hosted-launches', { authenticated: true });
  } catch (error) {
    if (error instanceof GatewayError && error.kind === 'http' && error.status === 404) return null;
    throw error;
  }
  return z.array(cloudLaunchSchema).parse(await response.json());
}

/**
 * The caller's cloud machines. Unlike the launch list, a 404 here is not read
 * as "no cloud agents": a server that lists launches but not machines is one
 * this Console does not match.
 */
export async function listCloudMachines(server: SwitchServer): Promise<CloudMachine[]> {
  const response = await gatewayFetch(server, '/hosted-machines', { authenticated: true });
  return z.object({ machines: z.array(cloudMachineSchema) }).parse(await response.json()).machines;
}

/** The caller's cloud machines, or null when the server has no cloud agents. */
export async function listServerCloudMachines(serverId: string): Promise<CloudMachine[] | null> {
  return onCloudServer(serverId, async (server) => {
    if ((await listCloudLaunches(server)) === null) return null;
    return listCloudMachines(server);
  });
}

/**
 * Why a launch's worker cannot be asked, machine first, or null when it can.
 * Read the way the server answers a read-only relay, which reports a sleeping
 * machine whatever the launch's own state.
 */
function launchProblem(
  launch: CloudLaunch,
  machine: CloudMachine | null
): CloudRelayProblem | null {
  if (launch.desired_state === 'deleted')
    return {
      code: 'worker_not_attached',
      message: 'The cloud agent is being removed.',
      wakeAvailable: false,
    };
  const phase = cloudAgentPhase(launch, machine);
  if (phase === 'machine_stopped')
    return {
      code: 'machine_stopped',
      message: 'The owner stopped the cloud machine.',
      wakeAvailable: false,
    };
  if (phase === 'machine_error')
    return {
      code: 'machine_error',
      message: machine?.error ?? 'The cloud machine is in error.',
      wakeAvailable: false,
    };
  if (machine ? machine.sleeping : launch.sleeping)
    return {
      code: 'worker_sleeping',
      message: 'The cloud machine is asleep.',
      wakeAvailable: phase === 'sleeping',
    };
  if (phase === 'waking')
    return {
      code: 'worker_waking',
      message: 'The cloud machine is starting.',
      wakeAvailable: false,
    };
  if (launch.desired_state === 'stopped')
    return { code: 'agent_stopped', message: 'The agent is stopped.', wakeAvailable: false };
  if (launch.state === 'error' && launch.error_code === 'agent_crashed')
    return {
      code: 'agent_crashed',
      message: launch.error ?? 'The agent crashed.',
      wakeAvailable: false,
    };
  if (launch.state !== 'ready' && launch.state !== 'running')
    return {
      code: 'worker_not_attached',
      message: `The cloud worker is ${launch.state}${launch.error ? `: ${launch.error}` : '.'}`,
      wakeAvailable: false,
    };
  return null;
}

/**
 * The server's cloud agents, read from the launch and machine lists, or null
 * when the server has no cloud agents. A launch whose worker cannot be asked
 * says why; the sessions of one that can are asked of its worker by
 * `listCloudSessions`, only for the agents being looked at.
 */
export async function listCloudAgents(serverId: string): Promise<CloudAgent[] | null> {
  const listed = await onCloudServer(serverId, listCloudLaunches);
  if (listed === null) return null;
  const launches = listed.filter(
    (launch) =>
      launch.state !== 'deleted' &&
      (launch.desired_state !== 'deleted' || launch.state === 'deleting')
  );
  const stored = await lastSessions.getAll();
  const keys = new Set(launches.map((launch) => cloudAgentKey(serverId, launch.request_id)));
  for (const key of Object.keys(stored))
    if (parseCloudAgentKey(key)?.serverId === serverId && !keys.has(key))
      await lastSessions.del(key);
  if (launches.length === 0) return [];
  const machines = new Map(
    (await onCloudServer(serverId, listCloudMachines)).map((machine) => [
      machine.machine_id,
      machine,
    ])
  );
  return launches.map((launch): CloudAgent => {
    const machine = launch.machine_id === null ? null : (machines.get(launch.machine_id) ?? null);
    const key = cloudAgentKey(serverId, launch.request_id);
    const problem = launchProblem(launch, machine);
    return {
      key,
      launch,
      machine,
      sessions: problem && KEEPS_LAST_SESSIONS.has(problem.code) ? (stored[key] ?? null) : null,
      problem,
    };
  });
}

/**
 * A cloud agent's sessions, asked of its worker over the relay. A worker that
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
  const { serverId, requestId } = launchOf(agentId);
  const launch = cloudLaunchSchema.parse(
    await onCloudServer(serverId, async (server) =>
      (await gatewayFetch(server, launchPath(requestId), { authenticated: true })).json()
    )
  );
  if (launch.machine_id === null)
    throw new Error(`The cloud agent ${launch.name} has no machine to start.`);
  const machineId = launch.machine_id;
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

const OPERATION_WAIT_MS = 180_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal the server answered, so it holds no operation for this request. */
function isDefiniteRefusal(error: unknown): error is GatewayError {
  return (
    error instanceof GatewayError &&
    (error.kind === 'unauthorized' ||
      (error.kind === 'http' && error.status !== undefined && error.status < 500))
  );
}

/**
 * Ask the worker to start a new session (`start`) or run an existing one
 * again (`restart`), and wait until it says it has. `operationId` is the
 * attempt's identity: after an `unknown` outcome, ask again with the same id
 * and the server returns the operation it already holds instead of queueing
 * another. A start's id is its session id.
 */
export async function runCloudSessionOperation(
  agentId: string,
  sessionId: string,
  operationId: string,
  action: 'start' | 'restart'
): Promise<CloudOperationOutcome> {
  if (action === 'start' && operationId !== sessionId)
    throw new Error('A cloud session start is identified by its session id.');
  const { serverId, requestId } = launchOf(agentId);
  let operation: CloudOperation;
  try {
    operation = cloudOperationSchema.parse(
      await onCloudServer(serverId, async (server) =>
        (
          await gatewayFetch(server, launchPath(requestId, '/sessions'), {
            authenticated: true,
            method: 'POST',
            body: { id: operationId, session_id: sessionId, action },
          })
        ).json()
      )
    );
  } catch (error) {
    if (isDefiniteRefusal(error))
      return { state: 'failed', message: error.detail ?? error.message, code: error.code ?? null };
    return {
      state: 'unknown',
      message: `The server did not confirm the session ${action}: ${errorMessage(error)}`,
    };
  }
  const deadline = Date.now() + OPERATION_WAIT_MS;
  try {
    while (operation.state === 'queued' || operation.state === 'claimed') {
      if (Date.now() >= deadline)
        return {
          state: 'unknown',
          message: `The cloud worker has not confirmed the session ${action} yet.`,
        };
      await delay(1000);
      operation = cloudOperationSchema.parse(
        await onCloudServer(serverId, async (server) =>
          (
            await gatewayFetch(
              server,
              launchPath(requestId, `/sessions/${encodeURIComponent(operationId)}`),
              { authenticated: true }
            )
          ).json()
        )
      );
    }
  } catch (error) {
    return {
      state: 'unknown',
      message: `The session ${action} could not be followed: ${errorMessage(error)}`,
    };
  }
  if (operation.state === 'applied') return { state: 'applied' };
  if (operation.state === 'failed')
    return {
      state: 'failed',
      message: operation.error ?? `The session ${action} failed.`,
      code: null,
    };
  return { state: 'unknown', message: `The outcome of the session ${action} is unknown.` };
}

/** Stage a file on the session's worker for the next message to name. */
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
