import type { LocalServerStatus } from '@shared/core/managed-switch-server/managed-switch-server';
import { defineEvent } from '@shared/lib/ipc/events';

/** Status of a remote-managed stack, tagged with the SSH host it runs on (the
 * renderer keeps one entry per host). Reuses the local status shape. */
export type RemoteServerStatus = LocalServerStatus & { sshHost: string };

export const remoteServerStatusChannel = defineEvent<RemoteServerStatus>(
  'remote-switch-server:status'
);

/** A line of `docker compose` output during a remote start, tagged with its
 * host so the UI routes it to the right log tail. */
export const remoteServerLogChannel = defineEvent<{ sshHost: string; line: string }>(
  'remote-switch-server:log'
);
