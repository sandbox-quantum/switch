import type { Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';

/**
 * A cloud agent is a managed agent placed on its owner's Switch cloud machine
 * controller (kind `ec2`). Its sessions run on that machine and are reached
 * through the server's relay for the agent, so where a local or SSH agent is
 * named by its Console agent id, a cloud one is named by this key and the same
 * session calls take either.
 */

const PREFIX = 'cloud:';
const AGENT_MARK = 'agent=';

export function cloudAgentKey(serverId: string, agentId: string): string {
  return `${PREFIX}${serverId}:${AGENT_MARK}${agentId}`;
}

/** The managed agent a cloud agent key names, and its server. */
export type CloudAgentTarget = { serverId: string; agentId: string };

export function parseCloudAgentKey(key: string): CloudAgentTarget | null {
  if (!key.startsWith(PREFIX)) return null;
  const at = key.lastIndexOf(':');
  const serverId = key.slice(PREFIX.length, at);
  const rest = key.slice(at + 1);
  if (!serverId || !rest.startsWith(AGENT_MARK)) return null;
  const agentId = rest.slice(AGENT_MARK.length);
  return agentId ? { serverId, agentId } : null;
}

const machineCapacitySchema = z
  .object({
    total_bytes: z.number().int().nonnegative(),
    available_bytes: z.number().int().nonnegative(),
  })
  .nullable();

/**
 * The owner's cloud machine, which every one of their cloud agents runs on.
 * `sleeping` is Core's reading of desired `stopped` for `idle`; `disk` and
 * `memory` come from the machine's last heartbeat.
 */
export const cloudMachineSchema = z.object({
  machine_id: z.string(),
  state: z.enum([
    'queued',
    'provisioning',
    'ready',
    'stopping',
    'stopped',
    'error',
    'retained',
    'deleting',
    'deleted',
  ]),
  desired_state: z.enum(['running', 'stopped', 'retained', 'deleted']),
  stop_reason: z.enum(['idle', 'owner']).nullable(),
  sleeping: z.boolean(),
  revision: z.number().int().positive(),
  instance_type: z.string().nullable(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  retain_until: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
  controller_id: z.string().nullable(),
  disk: machineCapacitySchema,
  memory: machineCapacitySchema,
  agents: z.array(z.string()),
});
export type CloudMachine = z.infer<typeof cloudMachineSchema>;

/**
 * Where a start or restart ended. `unknown` means the controller may have
 * acted: asking again for the same session is safe, since a start of a
 * session that exists goes on with it. A failure refused with a code carries
 * it, the relay's vocabulary (`worker_waking`, `machine_stopped`,
 * `machine_error`).
 */
export type CloudOperationOutcome =
  | { state: 'applied' }
  | { state: 'failed'; message: string; code: string | null }
  | { state: 'unknown'; message: string };

/** Why a cloud agent's sessions could not be read, with the relay's code. */
export type CloudRelayProblem = {
  code: string;
  message: string;
  /** Set on `worker_sleeping`: starting the agent's machine would wake it. */
  wakeAvailable: boolean;
};

/** A cloud agent's sessions, or why they could not be read. */
export type CloudSessions = {
  sessions: Session[] | null;
  problem: CloudRelayProblem | null;
};

/** The managed agent as its cloud machine's controller reports it. */
export type CloudControllerAgent = {
  controllerId: string;
  desiredState: 'running' | 'stopped';
  /** The process state the controller last reported, null before it has. */
  process: string | null;
  detail: string | null;
};

/**
 * A cloud agent with its sessions, or why they could not be read. `sessions`
 * is null until its machine has been asked. `machine` is the cloud machine
 * its controller runs on, null when that machine is not listed.
 */
export type CloudAgent = CloudSessions & {
  key: string;
  agentId: string;
  name: string;
  provider: string;
  machine: CloudMachine | null;
  controller: CloudControllerAgent;
};

/** Whether a managed agent's process has crashed or failed on its controller. */
export function controllerAgentCrashed(agent: CloudControllerAgent): boolean {
  return agent.process === 'crashed' || agent.process === 'failed';
}

export type CloudAgentPhase = 'sleeping' | 'waking' | 'machine_stopped' | 'machine_error';

/**
 * Whether the agent's machine is in error, stopped by its owner, asleep, or on
 * its way up; an error outranks a stop. Only an agent asked to run sleeps or
 * wakes with its machine: a message to a stopped one is refused rather than
 * waking it.
 */
export function cloudAgentPhase(
  machine: CloudMachine | null,
  controller: CloudControllerAgent
): CloudAgentPhase | null {
  if (machine?.state === 'error') return 'machine_error';
  if (machine?.desired_state === 'stopped' && machine.stop_reason === 'owner')
    return 'machine_stopped';
  if (controller.desiredState !== 'running') return null;
  if (machine?.sleeping) return 'sleeping';
  const machineWaking =
    machine?.desired_state === 'running' &&
    ['queued', 'provisioning', 'stopping', 'stopped', 'retained'].includes(machine.state);
  return machineWaking ? 'waking' : null;
}

/**
 * Whether a waking agent waits only on its own process, its machine already
 * up. The relay says `worker_waking` either way.
 */
export function cloudMachineReady(machine: CloudMachine | null): boolean {
  return machine?.state === 'ready';
}
