import type { LocalServerStatus } from '@shared/core/managed-switch-server/managed-switch-server';
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
};

export const remoteServerStatusChannel = defineEvent<RemoteServerStatus>(
  'remote-switch-server:status'
);

/** A line of `docker compose` output during a remote start, tagged with its
 * host so the UI routes it to the right log tail. */
export const remoteServerLogChannel = defineEvent<{ sshHost: string; line: string }>(
  'remote-switch-server:log'
);
