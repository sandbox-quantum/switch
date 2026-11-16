import { defineEvent } from '@shared/lib/ipc/events';

/**
 * A signed-in call to this server's gateway was refused with 401: its session
 * may have expired or been revoked (a password change elsewhere, "sign out of
 * all devices"). The window re-checks the server's sign-in rather than taking
 * this as a sign-out on its own.
 */
export const gatewaySessionEndedChannel = defineEvent<{ serverId: string }>(
  'switch-servers:session-ended'
);

/**
 * A window Console opened on this server's gateway pages was closed: what was
 * set up there (a connector's app, say) may have changed what Console shows.
 */
export const gatewayWindowClosedChannel = defineEvent<{ serverId: string }>(
  'switch-servers:gateway-window-closed'
);
