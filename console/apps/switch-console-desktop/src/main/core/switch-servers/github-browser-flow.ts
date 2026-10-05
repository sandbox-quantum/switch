import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelGitHubConnection,
  completeGitHubConnection,
  confirmGitHubConnection,
  getGitHubFlow,
  startGitHubConnection,
} from './gateway-client';

const active = new Map<string, { secret: string; close: () => void }>();
const key = (server: SwitchServer, id: string) => JSON.stringify([server.id, id]);

export async function startGitHubBrowserFlow(
  server: SwitchServer,
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
      response.end('Invalid authorization response.');
      return;
    }
    const code = url.searchParams.get('code');
    if (
      received ||
      request.method !== 'GET' ||
      url.origin !== `http://127.0.0.1:${port}` ||
      request.headers.host !== `127.0.0.1:${port}` ||
      url.pathname !== '/switch-github/callback' ||
      url.searchParams.get('state') !== state ||
      !code ||
      code.length > 512
    ) {
      response.writeHead(400);
      response.end(
        'This connection was not started by this Switch Console. Return to the computer where you started it.'
      );
      return;
    }
    received = true;
    listener.close();
    void completeGitHubConnection(server, state, code, secret)
      .then(() => {
        response.end('GitHub authorized. Return to Switch Console to confirm the account.');
      })
      .catch(() => {
        active.delete(key(server, state));
        response.writeHead(400);
        response.end('Sign-in was interrupted. Start it again from Switch Console.');
      });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new Error('Could not open the local GitHub callback.');
  }
  port = address.port;
  const timeout = setTimeout(() => {
    active.delete(key(server, state));
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
  active.set(key(server, state), entry);
  let started = false;
  try {
    const flow = await startGitHubConnection(server, { port, state, completion_secret: secret });
    started = true;
    if (flow.id !== state) throw new Error('The GitHub authorization does not match this Console.');
    try {
      await open(flow.url);
    } catch (cause) {
      throw new Error('Could not open GitHub in your browser.', { cause });
    }
    return state;
  } catch (error) {
    entry.close();
    active.delete(key(server, state));
    if (started) {
      try {
        await cancelGitHubConnection(server, state);
      } catch (cancelError) {
        log.warn('Could not cancel GitHub authorization', cancelError);
      }
    }
    throw error;
  }
}

export async function getGitHubBrowserFlow(server: SwitchServer, id: string) {
  const entry = active.get(key(server, id));
  if (!entry) throw new Error('Sign-in was interrupted. Start it again from Switch Console.');
  return getGitHubFlow(server, id);
}

export async function confirmGitHubBrowserFlow(server: SwitchServer, id: string) {
  const entry = active.get(key(server, id));
  if (!entry) throw new Error('Sign-in was interrupted. Start it again from Switch Console.');
  const result = await confirmGitHubConnection(server, id, entry.secret);
  entry.close();
  active.delete(key(server, id));
  return result;
}

export async function cancelGitHubBrowserFlow(server: SwitchServer, id: string) {
  active.get(key(server, id))?.close();
  active.delete(key(server, id));
  await cancelGitHubConnection(server, id);
}
