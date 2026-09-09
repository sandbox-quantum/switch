import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  commandSchema,
  serverEventSchema,
  snapshotSchema,
} from '@switch-console/shared/session-v1';
import type { Session } from '@switch-console/shared/session-v1';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { Journal } from './journal';
import { HostedSession } from './session-host';
import { SharedDelivery } from './shared-delivery';
import { SharedState } from './shared-state';

export type SharedHostOptions = {
  root: string;
  agentApiUrl: string;
  token: string;
  session: Session;
  input: ProviderSessionStartInput;
};

class TransportError extends Error {}
export class SharedHostLeaseExpiredError extends Error {
  constructor() {
    super('HOST_OFFLINE: lease renewal deadline passed.');
    this.name = 'SharedHostLeaseExpiredError';
  }
}

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
  const state = await SharedState.open(options);
  const stopped = new AbortController();
  const executionSignal = AbortSignal.any([signal, stopped.signal]);
  let host: HostedSession | null = null;
  let delivery: SharedDelivery | null = null;
  let failure: unknown = null;
  let starting = false;
  let deadline = Infinity;
  let lease = state.latest('lease');
  let heartbeat: Promise<void> = Promise.resolve();
  let shutdown: Promise<void> | null = null;
  const sessionPath = `/${encodeURIComponent(options.session.sessionId)}`;
  const requestOnce = async (path: string, body: unknown, abort: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${base.href.replace(/\/$/, '')}/sessions${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort, AbortSignal.timeout(5000)]),
        redirect: 'error',
      });
    } catch (error) {
      if (abort.aborted) throw error;
      throw new TransportError(`Switch session transport unavailable: ${String(error)}`);
    }
    if ([429, 500, 502, 503, 504].includes(response.status))
      throw new TransportError(`Switch session transport unavailable (${response.status}).`);
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 409) {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (body && typeof body === 'object' && 'code' in body && body.code === 'HOST_OFFLINE')
          throw new SharedHostLeaseExpiredError();
      }
      throw new Error(`Switch session request failed (${response.status}): ${text}`);
    }
    return response.json();
  };
  const request = async (path: string, body: unknown): Promise<unknown> => {
    let disconnected = false;
    while (true) {
      executionSignal.throwIfAborted();
      if (performance.now() >= deadline) throw new SharedHostLeaseExpiredError();
      try {
        const result = await requestOnce(path, body, executionSignal);
        if (disconnected) console.info('Shared host connection restored.');
        return result;
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        if (!disconnected) console.warn(error.message);
        disconnected = true;
        await delay(500, undefined, { signal: executionSignal });
      }
    }
  };
  const stopExecution = async () => {
    if (host) {
      shutdown ??= host.shutdown();
      await shutdown;
    }
  };
  const onAbort = () => {
    void stopExecution().catch((error) => {
      failure ??= error;
    });
  };
  executionSignal.addEventListener('abort', onAbort, { once: true });
  const upload = async (reconcile: boolean) => {
    for (const event of delivery!.pending()) {
      const receipt = await request(
        `/${reconcile ? 'reconcile' : 'events'}?host_id=${encodeURIComponent(options.session.hostId)}`,
        event
      );
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        !('throughHostSequence' in receipt) ||
        typeof receipt.throughHostSequence !== 'number' ||
        receipt.throughHostSequence < event.hostSequence
      )
        throw new Error('Switch returned an invalid host event receipt.');
      await delivery!.acknowledge(receipt.throughHostSequence);
    }
  };
  const validateSession = (snapshot: unknown) => {
    const parsed = snapshotSchema.parse(snapshot);
    const { session } = parsed;
    if (
      session.sessionId !== options.session.sessionId ||
      session.agentId !== options.session.agentId ||
      session.hostId !== options.session.hostId ||
      session.provider !== options.session.provider
    )
      throw new Error('Switch returned a different session identity.');
    return parsed;
  };
  const finish = async () => {
    if (starting)
      throw new Error(
        'FENCING_REQUIRED: provider startup failed before shutdown could be confirmed.'
      );
    await stopExecution();
    if (host && delivery)
      for (const event of host.replay(delivery.cursor).events) await delivery.capture(event);
    await state.journal.append({ type: 'quiesced' });
    if (lease) {
      try {
        await requestOnce(
          `${sessionPath}/quiesce`,
          { host_id: lease.snapshot.session.hostId, epoch: lease.snapshot.session.epoch },
          AbortSignal.timeout(5000)
        );
      } catch (error) {
        console.warn(
          'Shared host stopped; server quiescence will be retried on recovery:',
          String(error)
        );
      }
    }
    await state.unlock();
  };
  try {
    // Complete a recovery whose response may have been lost before doing anything else.
    const recovery = state.latest('recover');
    if (recovery && (!lease || recovery.epoch === lease.snapshot.session.epoch)) {
      const snapshot = validateSession(
        await request(`${sessionPath}/recover`, {
          host_id: options.session.hostId,
          epoch: recovery.epoch,
          operation_id: recovery.operationId,
          through_host_sequence: recovery.throughHostSequence,
        })
      );
      await state.journal.append({ type: 'lease', snapshot, sourceBase: recovery.sourceBase });
      lease = state.latest('lease');
    }
    if (lease) {
      const prior = lease.snapshot.session;
      await request(`${sessionPath}/quiesce`, { host_id: prior.hostId, epoch: prior.epoch });
      delivery = await SharedDelivery.load(options.root, prior, lease.sourceBase);
      const events = await Journal.load(join(options.root, 'events.jsonl'), (value) =>
        serverEventSchema.parse(value)
      );
      for (const event of events.records.filter((event) => event.sequence > delivery!.cursor))
        await delivery.capture(event);
      await upload(true);
      const operation = {
        type: 'recover' as const,
        operationId: randomUUID(),
        epoch: prior.epoch,
        sourceBase: delivery.cursor,
        throughHostSequence: delivery.throughHostSequence,
      };
      await state.journal.append(operation);
      const snapshot = validateSession(
        await request(`${sessionPath}/recover`, {
          host_id: prior.hostId,
          epoch: prior.epoch,
          operation_id: operation.operationId,
          through_host_sequence: operation.throughHostSequence,
        })
      );
      await state.journal.append({ type: 'lease', snapshot, sourceBase: operation.sourceBase });
    } else {
      const snapshot = validateSession(
        await request('/claim', {
          session: state.identity.session,
          operation_id: state.identity.operationId,
        })
      );
      await state.journal.append({ type: 'lease', snapshot, sourceBase: 0 });
    }
    lease = state.latest('lease')!;
    const session = lease.snapshot.session;
    const hostLease = { host_id: session.hostId, epoch: session.epoch };
    // Renew before opening a provider, including after a lost acquisition response.
    const renewingAt = performance.now();
    await request(`${sessionPath}/renew`, hostLease);
    deadline = renewingAt + 25000;
    delivery = await SharedDelivery.load(options.root, session, lease.sourceBase);
    heartbeat = (async () => {
      try {
        while (!executionSignal.aborted) {
          await delay(5000, undefined, { signal: executionSignal });
          const renewingAt = performance.now();
          await request(`${sessionPath}/renew`, hostLease);
          deadline = renewingAt + 25000;
        }
      } catch (error) {
        if (!executionSignal.aborted) {
          failure = error;
          stopped.abort(error);
        }
      }
    })();
    await state.journal.append({ type: 'running' });
    starting = true;
    host = await HostedSession.start(
      options.root,
      { session, input: options.input, epochAuthority: 'server' },
      adapter
    );
    starting = false;
    const flush = async () => {
      for (const event of host!.replay(delivery!.cursor).events) await delivery!.capture(event);
      await upload(false);
    };
    while (!executionSignal.aborted) {
      await flush();
      const commands = await request(`${sessionPath}/commands`, hostLease);
      if (!Array.isArray(commands)) throw new Error('Switch returned an invalid command batch.');
      for (const value of commands) {
        executionSignal.throwIfAborted();
        if (performance.now() >= deadline) throw new SharedHostLeaseExpiredError();
        const command = commandSchema.parse(value);
        if (command.sessionId !== session.sessionId || command.epoch !== session.epoch)
          throw new Error('Switch returned a command for another session generation.');
        await host.command(command);
        await flush();
      }
      await delay(250, undefined, { signal: executionSignal });
    }
  } catch (error) {
    if (!signal.aborted) failure ??= error;
  } finally {
    stopped.abort();
    await heartbeat;
    try {
      await finish();
    } catch (error) {
      failure = error;
    }
    executionSignal.removeEventListener('abort', onAbort);
  }
  if (failure) throw failure;
}
