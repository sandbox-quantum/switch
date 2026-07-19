import type { LocalServerStatus } from '@shared/core/local-switch-server/local-switch-server';
import { defineEvent } from '@shared/lib/ipc/events';

export const localServerStatusChannel = defineEvent<LocalServerStatus>(
  'local-switch-server:status'
);

/** A line of `docker compose` output during a start, so the UI can show a live
 * log tail for the (slow) image pull + container startup. */
export const localServerLogChannel = defineEvent<{ line: string }>('local-switch-server:log');
