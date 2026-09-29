import type {
  LocalServerStatus,
  ServerLockHolder,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { defineEvent } from '@shared/lib/ipc/events';

/** Status of a remote-managed stack, tagged with the SSH host it runs on (the
 * renderer keeps one entry per host). Reuses the local status shape. */
export type RemoteServerStatus = LocalServerStatus & {
  sshHost: string;
  /**
   * Something about the stack this Console did not do and the user should
   * know, or null (CHOO-2893). A remote stack is shared, so it can be stopped,
   * reset or restarted from another Console or on the host itself; this is
   * where that is said, rather than leaving the next call to fail with a
   * transport error naming a local port.
   */
  notice: string | null;
  /**
   * Why this Console could not record what it did on the stack's host, or
   * null (CHOO-2893). The operation itself went ahead — a stack is still
   * started or stopped when its record cannot be written — but the other
   * Consoles sharing it will not see it in the server's users or activity,
   * which is what they rely on before stopping or resetting it. Cleared by
   * the next record that succeeds.
   */
  recordWarning: string | null;
  /**
   * The other Console this one is waiting on before it can change or read the
   * stack, or null (CHOO-2893). Whoever changes a shared stack holds its lock,
   * and a start, a join or a check here waits for them rather than acting on
   * a stack that is half-way through their start. The wait can be cancelled.
   */
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
