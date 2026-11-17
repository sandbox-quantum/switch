import {
  managedServerHostBlocked,
  managedServerStoppedPhase,
} from '@main/core/managed-switch-server/managed-server-status';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { consoleIdentityHeaders } from './console-identity';
import { getSessionCookie } from './servers-store';

const SIGN_OUT_TIMEOUT_MS = 5_000;

/**
 * Signs this Console's session out on the server, with the session cookie it
 * holds, before that copy is forgotten. Sent directly rather than through the
 * gateway client, which would renew a session near its expiry, or sign a
 * managed server in again, on the way to ending it.
 *
 * Never throws: signing out of this Console cannot wait on a server that does
 * not answer. A server that is down, or refuses, is logged and the local copy
 * still goes.
 */
export async function signOutOnServer(server: SwitchServer): Promise<void> {
  const fields = { serverId: server.id };
  let cookie: string | null;
  try {
    cookie = await getSessionCookie(server.id);
  } catch (error) {
    log.warn('Could not read the session to sign out of on the server; forgetting it here only', {
      ...fields,
      error: String(error),
    });
    return;
  }
  if (!cookie) return;
  if (managedServerHostBlocked(server) || managedServerStoppedPhase(server)) {
    log.warn('The server is not reachable, so its session is forgotten here only', fields);
    return;
  }
  try {
    const response = await fetch(`${server.url}/gateway/auth/logout`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Cookie: `switch_auth=${cookie}`,
        ...(await consoleIdentityHeaders(server)),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
    });
    if (!response.ok)
      log.warn('The server refused to sign the session out; forgetting it here only', {
        ...fields,
        status: response.status,
      });
  } catch (error) {
    log.warn('Could not reach the server to sign the session out; forgetting it here only', {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
