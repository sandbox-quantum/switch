import { randomBytes } from 'node:crypto';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelGitHubConnection,
  completeGitHubConnection,
  getGitHubFlow,
  startGitHubConnection,
} from './gateway-client';
import { listenForSignIn } from './sign-in-listener';

const active = new Map<string, { secret: string; close: () => void }>();
const key = (server: SwitchServer, id: string) => JSON.stringify([server.id, id]);

export async function startGitHubBrowserFlow(
  server: SwitchServer,
  open: (url: string) => Promise<void>
): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const listener = await listenForSignIn({
    name: 'GitHub',
    path: '/switch-github/callback',
    state,
    maxCodeLength: 512,
    ports: null,
    complete: async (code) => {
      try {
        await completeGitHubConnection(server, state, code, secret);
      } catch (error) {
        active.delete(key(server, state));
        throw error;
      }
    },
  });
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
    const flow = await startGitHubConnection(server, {
      port: listener.port,
      state,
      completion_secret: secret,
    });
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

/**
 * Where the sign-in stands. Once it reads connected the flow is over: the
 * listener and secret go, and the server is told it can drop the flow. A
 * failed flow stays until the person cancels it, so the reason stays readable.
 */
export async function getGitHubBrowserFlow(server: SwitchServer, id: string) {
  const entry = active.get(key(server, id));
  if (!entry) throw new Error('Sign-in was interrupted. Start it again from Switch Console.');
  const flow = await getGitHubFlow(server, id);
  if (flow.status === 'connected') {
    entry.close();
    active.delete(key(server, id));
    cancelGitHubConnection(server, id).catch((cause: unknown) =>
      log.warn('Could not drop a finished GitHub sign-in', cause)
    );
  }
  return flow;
}

export async function cancelGitHubBrowserFlow(server: SwitchServer, id: string) {
  active.get(key(server, id))?.close();
  active.delete(key(server, id));
  await cancelGitHubConnection(server, id);
}
