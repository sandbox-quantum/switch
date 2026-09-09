import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { commandSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import type { Session } from '@switch-console/shared/session-v1';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { HostedSession } from './session-host';
import { SharedDelivery } from './shared-delivery';

export type SharedHostOptions = {
  root: string;
  agentApiUrl: string;
  token: string;
  session: Session;
  input: ProviderSessionStartInput;
};

/** A shared execution process consumes only commands reserved by Switch. */
export async function runSharedHost(
  options: SharedHostOptions,
  adapter: ProviderAdapter,
  signal: AbortSignal
): Promise<void> {
  const base = new URL(options.agentApiUrl);
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  )
    throw new Error('Shared host credentials require HTTPS or a loopback server.');
  if (base.username || base.password || base.search || base.hash)
    throw new Error('Agent API URL must not contain credentials, a query, or a fragment.');
  if (options.session.sessionId !== options.input.sessionId)
    throw new Error('Shared host session identity mismatch.');
  // An existing journal needs explicit recovery; never start a second execution over it.
  await mkdir(options.root, { mode: 0o700 });
  const stopped = new AbortController();
  const executionSignal = AbortSignal.any([signal, stopped.signal]);
  let host: HostedSession | null = null;
  let heartbeatFailure: unknown = null;
  const request = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`${base.href.replace(/\/$/, '')}/sessions${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([executionSignal, AbortSignal.timeout(5000)]),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        `Switch session request failed (${response.status}): ${await response.text()}`
      );
    return response.json();
  };
  const acquired = snapshotSchema.parse(await request('/acquire', options.session));
  if (
    acquired.session.sessionId !== options.session.sessionId ||
    acquired.session.agentId !== options.session.agentId ||
    acquired.session.hostId !== options.session.hostId
  )
    throw new Error('Switch returned a different session identity.');
  const session = acquired.session;
  const lease = { host_id: session.hostId, epoch: session.epoch };
  const sessionPath = `/${encodeURIComponent(session.sessionId)}`;
  let shutdown: Promise<void> | null = null;
  const stopExecution = async () => {
    if (host) {
      shutdown ??= host.shutdown();
      await shutdown;
    }
  };
  const onAbort = () => {
    void stopExecution().catch((error: unknown) => {
      heartbeatFailure ??= error;
    });
  };
  executionSignal.addEventListener('abort', onAbort, { once: true });
  const heartbeat = (async () => {
    try {
      while (!executionSignal.aborted) {
        await delay(5000, undefined, { signal: executionSignal });
        await request(`${sessionPath}/renew`, lease);
      }
    } catch (error) {
      if (!executionSignal.aborted) {
        heartbeatFailure = error;
        stopped.abort(error);
        await stopExecution();
      }
    }
  })();
  const delivery = await SharedDelivery.load(options.root, session);
  try {
    host = await HostedSession.start(options.root, { session, input: options.input }, adapter);
    const flush = async () => {
      for (const event of host!.replay(delivery.cursor).events) await delivery.capture(event);
      for (const event of delivery.pending()) {
        const receipt = await request(
          `/events?host_id=${encodeURIComponent(session.hostId)}`,
          event
        );
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          !('throughHostSequence' in receipt) ||
          receipt.throughHostSequence !== event.hostSequence
        )
          throw new Error('Switch returned an invalid host event receipt.');
        await delivery.acknowledge(receipt.throughHostSequence);
      }
    };
    while (!executionSignal.aborted) {
      await flush();
      const commands = await request(`${sessionPath}/commands`, lease);
      if (!Array.isArray(commands)) throw new Error('Switch returned an invalid command batch.');
      for (const value of commands) {
        executionSignal.throwIfAborted();
        const command = commandSchema.parse(value);
        if (command.sessionId !== session.sessionId || command.epoch !== session.epoch)
          throw new Error('Switch returned a command for another session generation.');
        await host.command(command);
        await flush();
      }
      await delay(250, undefined, { signal: executionSignal });
    }
  } catch (error) {
    if (!signal.aborted) throw heartbeatFailure ?? error;
  } finally {
    stopped.abort();
    await heartbeat;
    await stopExecution();
    executionSignal.removeEventListener('abort', onAbort);
  }
  if (heartbeatFailure) throw heartbeatFailure;
}
