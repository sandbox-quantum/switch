import type {
  LocalServerStatus,
  ServerLockHolder,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { defineEvent } from '@shared/lib/ipc/events';

/** Status of a remote-managed stack, tagged with the SSH host it runs on (the
 * renderer keeps one entry per host). Reuses the local status shape. */
export type RemoteServerStatus = LocalServerStatus & {
  sshHost: string;
  /** Something done to the stack from elsewhere (another Console, or the host
   * itself) that the user should know, or null. */
  notice: string | null;
  /** Why this Console could not record what it did on the stack's host, or
   * null. The operation still went ahead, but other Consoles will not see it.
   * Cleared by the next record that succeeds. */
  recordWarning: string | null;
  /** The other Console whose lock this one is waiting on before it can change
   * or read the stack, or null. The wait can be cancelled. */
  waitingFor: ServerLockHolder | null;
};

export const remoteServerStatusChannel = defineEvent<RemoteServerStatus>(
  'remote-switch-server:status'
);

/** A line of `docker compose` output during a remote start, tagged with its
 * host so the UI routes it to the right log tail. */
export const remoteServerLogChannel = defineEvent<{ sshHost: string; line: string }>(
  'remote-switch-server:log'
);
