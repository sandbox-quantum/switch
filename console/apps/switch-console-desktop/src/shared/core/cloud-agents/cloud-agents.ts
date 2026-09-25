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
});
export type CloudLaunch = z.infer<typeof cloudLaunchSchema>;

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
 * than a new one.
 */
export type CloudOperationOutcome =
  | { state: 'applied' }
  | { state: 'failed'; message: string }
  | { state: 'unknown'; message: string };

/** Why a cloud agent's sessions could not be read, with the relay's code. */
export type CloudRelayProblem = {
  code: string;
  message: string;
  /** Set on `worker_sleeping`: a start would wake the launch. */
  wakeAvailable: boolean;
};

/** A launch with its worker's sessions, or why they could not be read. */
export type CloudAgent = {
  key: string;
  launch: CloudLaunch;
  sessions: Session[] | null;
  problem: CloudRelayProblem | null;
};

/** Whether the launch is asleep, and whether a wake has been asked for. */
export function cloudLaunchPhase(launch: CloudLaunch): 'sleeping' | 'waking' | null {
  if (launch.sleeping) return 'sleeping';
  if (launch.desired_state === 'running' && ['queued', 'provisioning'].includes(launch.state))
    return 'waking';
  return null;
}
