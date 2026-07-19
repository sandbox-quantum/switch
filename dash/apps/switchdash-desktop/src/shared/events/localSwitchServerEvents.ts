import type { LocalServerStatus } from '@shared/core/local-switch-server/local-switch-server';
import { defineEvent } from '@shared/lib/ipc/events';

export const localServerStatusChannel = defineEvent<LocalServerStatus>(
  'local-switch-server:status'
);
