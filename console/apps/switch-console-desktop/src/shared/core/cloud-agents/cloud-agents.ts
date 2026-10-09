import type { Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';

/**
 * A cloud agent is a hosted launch on a Switch server. Its sessions run on
 * the launch's worker and are reached through the server's relay, so where a
 * local or SSH agent is named by its Console agent id, a cloud one is named by
 * this key and the same session calls take either.
 */

const PREFIX = 'cloud:';

export function cloudAgentKey(serverId: string, requestId: string): string {
  return `${PREFIX}${serverId}:${requestId}`;
}

export function parseCloudAgentKey(key: string): { serverId: string; requestId: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const at = key.lastIndexOf(':');
  const serverId = key.slice(PREFIX.length, at);
  const requestId = key.slice(at + 1);
  return serverId && requestId ? { serverId, requestId } : null;
}

export const cloudLaunchSchema = z.object({
  request_id: z.string().uuid(),
  name: z.string(),
  provider: z.enum(['claude', 'codex', 'opencode', 'cursor', 'antigravity']),
  state: z.string(),
  desired_state: z.enum(['running', 'stopped', 'restart', 'deleted']),
  revision: z.number().int().positive(),
  agent_id: z.string().nullable(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  sleeping: z.boolean(),
  machine_id: z.string().nullable(),
  process_state: z
    .enum([
      'pending',
      'starting',
      'running',
      'stopping',
      'stopped',
      'restarting',
      'crashed',
      'failed',
    ])
    .nullable(),
  process_restarts: z.number().int().nonnegative(),
  oom_kills: z.number().int().nonnegative(),
});
export type CloudLaunch = z.infer<typeof cloudLaunchSchema>;

const machineCapacitySchema = z
  .object({
    total_bytes: z.number().int().nonnegative(),
    available_bytes: z.number().int().nonnegative(),
  })
  .nullable();

/**
 * The owner's cloud machine, which every one of their launches runs on.
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
  disk: machineCapacitySchema,
  memory: machineCapacitySchema,
  agents: z.array(z.string()),
  /**
   * `controller`: the machine runs the agents controller, and its agents are
   * managed agents placed on `controller_id` (null until it has enrolled).
   * A server from before machines could run it sends neither: `worker`.
   */
  runtime: z.enum(['worker', 'controller']).default('worker'),
  controller_id: z.string().nullable().default(null),
});
export type CloudMachine = z.infer<typeof cloudMachineSchema>;

export const cloudOperationSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  action: z.enum(['start', 'restart']),
  state: z.enum(['queued', 'claimed', 'applied', 'failed', 'unknown']),
  error: z.string().nullable(),
});
export type CloudOperation = z.infer<typeof cloudOperationSchema>;

/**
 * Where a start or restart ended. `unknown` means the server may hold the
 * operation: ask again with the same id, which the server dedupes, rather
 * than a new one. A failure the server refused with a code carries it, the
 * relay's vocabulary (`worker_waking`, `machine_stopped`, `machine_error`).
 */
export type CloudOperationOutcome =
  | { state: 'applied' }
  | { state: 'failed'; message: string; code: string | null }
  | { state: 'unknown'; message: string };

/** Why a cloud agent's sessions could not be read, with the relay's code. */
export type CloudRelayProblem = {
  code: string;
  message: string;
  /** Set on `worker_sleeping`: starting the launch's machine would wake it. */
  wakeAvailable: boolean;
};

/** A worker's sessions, or why they could not be read. */
export type CloudSessions = {
  sessions: Session[] | null;
  problem: CloudRelayProblem | null;
};

/**
 * A launch with its worker's sessions, or why they could not be read.
 * `sessions` is null until the worker has been asked. `machine` is the
 * machine the launch runs on, null when it has none or it is not listed.
 */
export type CloudAgent = CloudSessions & {
  key: string;
  launch: CloudLaunch;
  machine: CloudMachine | null;
};

export type CloudAgentPhase = 'sleeping' | 'waking' | 'machine_stopped' | 'machine_error';

/**
 * Whether the agent's machine is in error, stopped by its owner, asleep, or on
 * its way up; an error outranks a stop. The machine is read first; a launch
 * without one says for itself.
 * Only a launch asked to run and not in error sleeps or wakes with its
 * machine: a message to a stopped or crashed one is refused rather than
 * waking it.
 */
export function cloudAgentPhase(
  launch: CloudLaunch,
  machine: CloudMachine | null
): CloudAgentPhase | null {
  if (machine?.state === 'error') return 'machine_error';
  if (machine?.desired_state === 'stopped' && machine.stop_reason === 'owner')
    return 'machine_stopped';
  if (launch.desired_state !== 'running' || launch.state === 'error') return null;
  if (machine ? machine.sleeping : launch.sleeping) return 'sleeping';
  if (
    machine?.desired_state === 'running' &&
    ['queued', 'provisioning', 'stopping', 'stopped', 'retained'].includes(machine.state)
  )
    return 'waking';
  if (['queued', 'provisioning'].includes(launch.state)) return 'waking';
  return null;
}

/**
 * Whether a waking agent waits only on its own process, its machine already
 * up. The relay says `worker_waking` either way.
 */
export function cloudMachineReady(machine: CloudMachine | null): boolean {
  return machine?.state === 'ready';
}
