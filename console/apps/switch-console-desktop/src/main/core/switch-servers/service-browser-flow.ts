import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { log } from '@main/lib/logger';
import { SERVICE_CALLBACK_PATH } from '@shared/core/switch-servers/service-connection';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelServiceConnection,
  completeServiceConnection,
  confirmServiceConnection,
  getConnectionCatalog,
  getServiceFlow,
  startServiceConnection,
} from './gateway-client';

/**
 * Signing in to a service through Switch's generic OAuth flow, from this
 * Console: GitHub's browser flow (`github-browser-flow.ts`) for any service,
 * keyed by its slug.
 *
 * A listener on 127.0.0.1 takes the code back, whether the vendor redirects
 * to it directly or Core relays it after its own callback, and hands it to
 * Core with the completion secret only this Console holds. Neither the
 * listener nor the browser ever sees a token: Core exchanges the code.
 */
/** Some vendors issue codes as signed tokens: Atlassian's run past 2,000 characters. */
const MAX_CODE_LENGTH = 8192;
const active = new Map<string, { secret: string; close: () => void }>();
const key = (server: SwitchServer, service: string, id: string) =>
  JSON.stringify([server.id, service, id]);

export async function startServiceBrowserFlow(
  server: SwitchServer,
  service: string,
  open: (url: string) => Promise<void>
): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  let received = false;
  let port = 0;
  const listener = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      response.writeHead(400);
      response.end('Invalid sign-in response.');
      return;
    }
    const code = url.searchParams.get('code');
    if (
      received ||
      request.method !== 'GET' ||
      url.origin !== `http://127.0.0.1:${port}` ||
      request.headers.host !== `127.0.0.1:${port}` ||
      url.pathname !== SERVICE_CALLBACK_PATH ||
      url.searchParams.get('state') !== state ||
      !code ||
      code.length > MAX_CODE_LENGTH
    ) {
      response.writeHead(400);
      response.end(
        'This connection was not started by this Switch Console. Return to the computer where you started it.'
      );
      return;
    }
    received = true;
    listener.close();
    void completeServiceConnection(server, service, state, code, secret)
      .then(() => {
        response.end('Signed in. Return to Switch Console to confirm the account.');
      })
      .catch(() => {
        response.writeHead(400);
        response.end('Sign-in was interrupted. Start it again from Switch Console.');
      });
  });
  const catalogEntry = (await getConnectionCatalog(server)).find(
    (candidate) => candidate.slug === service
  );
  await listenOn(listener, catalogEntry?.name ?? service, catalogEntry?.loopback_ports ?? null);
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new Error('Could not open the local sign-in callback.');
  }
  port = address.port;
  const timeout = setTimeout(() => {
    active.delete(key(server, service, state));
    listener.close();
  }, 600_000);
  timeout.unref();
  const entry = {
    secret,
    close: () => {
      clearTimeout(timeout);
      listener.close();
    },
  };
  active.set(key(server, service, state), entry);
  let started = false;
  try {
    const flow = await startServiceConnection(server, service, {
      port,
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

/**
 * Listen on loopback: on any port, or on the first free one of `ports`, for a
 * vendor that takes a sign-in back only on the ports Switch registered.
 */
async function listenOn(listener: Server, name: string, ports: number[] | null) {
  for (const port of ports ?? [0]) {
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => {
          listener.off('error', reject);
          resolve();
        });
      });
      return;
    } catch (error) {
      if (ports === null || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `${name} takes a sign-in back only on port ${(ports ?? []).join(', ')} of this computer, and all are in use. Close whatever is using them, and connect again.`
  );
}

function activeFlow(server: SwitchServer, service: string, id: string) {
  const entry = active.get(key(server, service, id));
  if (!entry) throw new Error('Sign-in was interrupted. Start it again from Switch Console.');
  return entry;
}

export async function getServiceBrowserFlow(server: SwitchServer, service: string, id: string) {
  activeFlow(server, service, id);
  return getServiceFlow(server, service, id);
}

export async function confirmServiceBrowserFlow(server: SwitchServer, service: string, id: string) {
  const entry = activeFlow(server, service, id);
  const result = await confirmServiceConnection(server, service, id, entry.secret);
  entry.close();
  active.delete(key(server, service, id));
  return result;
}

export async function cancelServiceBrowserFlow(server: SwitchServer, service: string, id: string) {
  active.get(key(server, service, id))?.close();
  active.delete(key(server, service, id));
  await cancelServiceConnection(server, service, id);
}
