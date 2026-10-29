import { randomBytes } from 'node:crypto';
import { log } from '@main/lib/logger';
import {
  SERVICE_CALLBACK_PATH,
  type ServiceFlow,
} from '@shared/core/switch-servers/service-connection';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelServiceConnection,
  completeServiceConnection,
  failServiceConnection,
  getConnectionCatalog,
  getServiceFlow,
  startServiceConnection,
} from './gateway-client';
import { listenForSignIn } from './sign-in-listener';

/**
 * Signing in to a service through Switch's generic OAuth flow, from this
 * Console: GitHub's browser flow (`github-browser-flow.ts`) for any service,
 * keyed by its slug. The listener takes the code back and hands it to Core
 * with the completion secret only this Console holds; Core connects the
 * service in that step, and the renderer reads the outcome from the flow. A
 * refusal the vendor sends the listener instead is handed to Core the same
 * way, and fails the flow with the vendor's reason.
 */
/** Some vendors issue codes as signed tokens: Atlassian's run past 2,000 characters. */
const MAX_CODE_LENGTH = 8192;
const active = new Map<string, { secret: string; close: () => void; refused: string | null }>();
const key = (server: SwitchServer, service: string, id: string) =>
  JSON.stringify([server.id, service, id]);

export async function startServiceBrowserFlow(
  server: SwitchServer,
  service: string,
  open: (url: string) => Promise<void>
): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const catalogEntry = (await getConnectionCatalog(server)).find(
    (candidate) => candidate.slug === service
  );
  const listener = await listenForSignIn({
    name: catalogEntry?.name ?? service,
    path: SERVICE_CALLBACK_PATH,
    state,
    maxCodeLength: MAX_CODE_LENGTH,
    ports: catalogEntry?.loopback_ports ?? null,
    complete: async (code) => {
      await completeServiceConnection(server, service, state, code, secret);
    },
    refuse: async ({ error, description, message }) => {
      const entry = active.get(key(server, service, state));
      if (entry) entry.refused = message;
      try {
        await failServiceConnection(server, service, state, error, description, secret);
      } catch (cause) {
        log.warn('Could not tell the server a service sign-in was refused', cause);
      }
    },
  });
  const timeout = setTimeout(() => {
    active.delete(key(server, service, state));
    listener.close();
  }, 600_000);
  timeout.unref();
  const entry = {
    secret,
    refused: null,
    close: () => {
      clearTimeout(timeout);
      listener.close();
    },
  };
  active.set(key(server, service, state), entry);
  let started = false;
  try {
    const flow = await startServiceConnection(server, service, {
      port: listener.port,
      state,
      completion_secret: secret,
    });
    started = true;
    try {
      await open(flow.url);
    } catch (cause) {
      throw new Error('Could not open the sign-in page in your browser.', { cause });
    }
    return state;
  } catch (error) {
    entry.close();
    active.delete(key(server, service, state));
    if (started) {
      try {
        await cancelServiceConnection(server, service, state);
      } catch (cancelError) {
        log.warn('Could not cancel a service sign-in', cancelError);
      }
    }
    throw error;
  }
}

function activeFlow(server: SwitchServer, service: string, id: string) {
  const entry = active.get(key(server, service, id));
  if (!entry) throw new Error('Sign-in was interrupted. Start it again from Switch Console.');
  return entry;
}

/**
 * Where the sign-in stands. Once it reads connected the flow is over: the
 * listener and secret go, and the server is told it can drop the flow. A
 * failed flow stays until the person cancels it, so the reason stays readable.
 */
export async function getServiceBrowserFlow(
  server: SwitchServer,
  service: string,
  id: string
): Promise<ServiceFlow> {
  const entry = activeFlow(server, service, id);
  const flow = await getServiceFlow(server, service, id);
  if (flow.status === 'connected') {
    entry.close();
    active.delete(key(server, service, id));
    cancelServiceConnection(server, service, id).catch((cause: unknown) =>
      log.warn('Could not drop a finished service sign-in', cause)
    );
  }
  // A server that could not be told of the vendor's refusal, or that predates
  // being told, still reads pending: the refusal is the outcome.
  if (flow.status === 'pending' && entry.refused !== null)
    return { ...flow, status: 'failed', error: entry.refused };
  return flow;
}

export async function cancelServiceBrowserFlow(server: SwitchServer, service: string, id: string) {
  active.get(key(server, service, id))?.close();
  active.delete(key(server, service, id));
  await cancelServiceConnection(server, service, id);
}
