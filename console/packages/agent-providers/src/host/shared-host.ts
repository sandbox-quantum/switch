import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  commandSchema,
  commandStatusSchema,
  serverEventSchema,
  snapshotSchema,
} from '@switch-console/shared/session-v1';
import type { Session } from '@switch-console/shared/session-v1';
import type { z } from 'zod';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { stageAttachment, MAX_ATTACHMENT_BYTES } from './attachments';
import { Journal } from './journal';
import { SharedRoomInbox, type roomConnectionSchema } from './room-inbox';
import { HostedSession } from './session-host';
import { SharedDelivery } from './shared-delivery';
import { SharedState } from './shared-state';

export type SharedHostOptions = {
  root: string;
  resumeOperationId?: string;
  authenticate?: (nativeSessionId: string | undefined) => Promise<void>;
  agentApiUrl: string;
  token: string;
  session: Session;
  input: ProviderSessionStartInput;
  roomConnection?: z.infer<typeof roomConnectionSchema>;
};

class TransportError extends Error {}
class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export class SharedHostLeaseExpiredError extends Error {
  constructor() {
    super('HOST_OFFLINE: lease renewal deadline passed.');
    this.name = 'SharedHostLeaseExpiredError';
  }
}

export class SharedHostFencedError extends Error {
  constructor(
    readonly pendingMessages: { roomId: string; messageId: string }[],
    cause: unknown,
    cleanupFailed: boolean
  ) {
    super(
      'HOST_NOT_OWNER: This host no longer owns the session. Automatic local relaunch is disabled. ' +
        (cleanupFailed ? 'Provider cleanup also failed. ' : '') +
        'Stop and start the agent to recover. Pending messages remain in the local inbox.',
      { cause }
    );
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
  let rooms: SharedRoomInbox | null = null;
  let deadline = performance.now() + 30000;
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
      let code = '';
      try {
        code = JSON.parse(text).code ?? '';
      } catch {
        /* The response may be plain text. */
      }
      throw new RequestError(code, `Switch session request failed (${response.status}): ${text}`);
    }
    return response.json();
  };
  const request = async (path: string, body: unknown): Promise<unknown> => {
    let disconnected = false;
    while (true) {
      executionSignal.throwIfAborted();
      if (performance.now() >= deadline) {
        if (lease) throw new SharedHostLeaseExpiredError();
        throw new Error(
          'HOST_START_TIMEOUT: Switch did not grant a session lease within 30 seconds. Check the server address and connectivity.'
        );
      }
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
  const noticeAttempts = new Map<string, number>();
  const localDeliveryNotices = new Set<string>();
  const reportRoomFailures = async (reason: 'startup' | 'conversation') => {
    if (!options.roomConnection || !lease || !rooms) return;
    const inbox = rooms;
    const activeLease = lease;
    const connectionId = options.roomConnection.connectionId;
    const targets = inbox
      .unreportedFailures(reason)
      .filter((event) => {
        const attempted = noticeAttempts.get(
          JSON.stringify([event.roomId, event.messageId, reason])
        );
        return attempted === undefined || performance.now() - attempted >= 30000;
      })
      .slice(0, 3);
    await Promise.all(
      targets.map(async (event) => {
        const key = JSON.stringify([event.roomId, event.messageId, reason]);
        const attempted = noticeAttempts.get(key);
        if (attempted !== undefined && performance.now() - attempted < 30000) return;
        noticeAttempts.set(key, performance.now());
        try {
          await requestOnce(
            `${sessionPath}/room-failure`,
            {
              host_id: activeLease.snapshot.session.hostId,
              epoch: activeLease.snapshot.session.epoch,
              connection_id: connectionId,
              room_id: event.roomId,
              message_id: event.messageId,
              reason,
            },
            AbortSignal.timeout(5000)
          );
          await inbox.markFailureNotified(event, reason);
        } catch (noticeError) {
          console.error('Could not report provider failure to the room:', String(noticeError));
          if (noticeError instanceof RequestError) noticeAttempts.set(key, Infinity);
        }
      })
    );
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
    if (starting) {
      starting = false;
      if (adapter.hasSession(options.session.sessionId))
        await adapter.stopSession(options.session.sessionId);
    }
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
    // The supervisor reaps the isolated group after this worker exits.
    // Retain its owner record so a replacement supervisor can fence it too.
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
    const session = structuredClone(lease.snapshot.session);
    const hostLease = { host_id: session.hostId, epoch: session.epoch };
    // Renew before opening a provider, including after a lost acquisition response.
    const renewingAt = performance.now();
    await request(`${sessionPath}/renew`, hostLease);
    deadline = renewingAt + 25000;
    delivery = await SharedDelivery.load(options.root, session, lease.sourceBase);
    let leaseSerial: Promise<unknown> = Promise.resolve();
    const withLease = <T>(action: () => Promise<T>): Promise<T> => {
      const result = leaseSerial.then(action);
      leaseSerial = result.catch(() => {});
      return result;
    };
    heartbeat = (async () => {
      try {
        while (!executionSignal.aborted) {
          await delay(5000, undefined, { signal: executionSignal });
          await withLease(async () => {
            const renewingAt = performance.now();
            await request(`${sessionPath}/renew`, hostLease);
            deadline = renewingAt + 25000;
          });
        }
      } catch (error) {
        if (!executionSignal.aborted) {
          failure = error;
          stopped.abort(error);
        }
      }
    })();
    await state.journal.append({ type: 'running' });
    if (options.roomConnection) {
      rooms = await SharedRoomInbox.open(options.root);
      await rooms.connect(
        { agentId: session.agentId, apiEndpoint: options.agentApiUrl, token: options.token },
        options.roomConnection,
        executionSignal,
        (error) => {
          failure = error;
          stopped.abort(error);
        }
      );
    }
    starting = true;
    host = await HostedSession.start(
      options.root,
      {
        session,
        input: options.input,
        epochAuthority: 'server',
        signal: executionSignal,
        resumeOperationId: options.resumeOperationId,
        authenticate: options.authenticate,
        stageAttachments: (attachments) =>
          Promise.all(
            attachments.map((attachment) =>
              stageAttachment(options.root, attachment, async () => {
                const url = `${base.href.replace(/\/$/, '')}/sessions${sessionPath}/attachments/${encodeURIComponent(attachment.attachmentId)}?host_id=${encodeURIComponent(hostLease.host_id)}&epoch=${encodeURIComponent(hostLease.epoch)}`;
                const response = await fetch(url, {
                  headers: { authorization: `Bearer ${options.token}` },
                  signal: AbortSignal.any([executionSignal, AbortSignal.timeout(15000)]),
                  redirect: 'error',
                });
                if (!response.ok || !response.body)
                  throw new Error(`Attachment download failed (${response.status}).`);
                const chunks: Uint8Array[] = [];
                let size = 0;
                const reader = response.body.getReader();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > MAX_ATTACHMENT_BYTES || size > attachment.bytes)
                      throw new Error('Attachment exceeds its declared size.');
                    chunks.push(value);
                  }
                } finally {
                  await reader.cancel();
                }
                return {
                  data: Buffer.concat(chunks),
                  sha256: response.headers.get('x-content-sha256') ?? '',
                };
              })
            )
          ),
        resetEpoch: () =>
          withLease(async () => {
            for (const event of host!.replay(delivery!.cursor).events)
              await delivery!.capture(event);
            await upload(false);
            await request(`${sessionPath}/quiesce`, hostLease);
            const operation = {
              type: 'recover' as const,
              operationId: randomUUID(),
              epoch: hostLease.epoch,
              sourceBase: delivery!.cursor,
              throughHostSequence: delivery!.throughHostSequence,
            };
            await state.journal.append(operation);
            const snapshot = validateSession(
              await request(`${sessionPath}/recover`, {
                host_id: hostLease.host_id,
                epoch: operation.epoch,
                operation_id: operation.operationId,
                through_host_sequence: operation.throughHostSequence,
              })
            );
            await state.journal.append({
              type: 'lease',
              snapshot,
              sourceBase: operation.sourceBase,
            });
            lease = state.latest('lease')!;
            hostLease.epoch = snapshot.session.epoch;
            delivery = await SharedDelivery.load(
              options.root,
              snapshot.session,
              operation.sourceBase
            );
            const renewingAt = performance.now();
            await request(`${sessionPath}/renew`, hostLease);
            deadline = renewingAt + 25000;
            return hostLease.epoch;
          }),
      },
      adapter
    );
    starting = false;
    const flush = async () => {
      for (const event of host!.replay(delivery!.cursor).events) await delivery!.capture(event);
      await upload(false);
    };
    let roomBinding: string | null = null;
    let heldForDecision = false;
    while (!executionSignal.aborted) {
      await flush();
      if (rooms && options.roomConnection) {
        const current = JSON.stringify(rooms.currentRooms());
        if (current !== roomBinding) {
          await request(`${sessionPath}/room-connection`, {
            ...hostLease,
            connection_id: options.roomConnection.connectionId,
          });
          roomBinding = current;
        }
      }
      if (host.snapshot().session.status === 'stopped') break;
      if (host.snapshot().session.status === 'error' && !host.resetDecisionPending)
        throw new Error(
          'HOST_FAULTED: Provider execution failed. The room connection is closing; inspect the transcript before recovery.'
        );
      if (host.resetDecisionPending) {
        heldForDecision = true;
        await reportRoomFailures('conversation');
      } else if (heldForDecision) {
        heldForDecision = false;
        const held = rooms?.pending().length ?? 0;
        if (held) {
          await host.roomBacklogDelivered(held);
          await flush();
        }
      }
      if (
        host.snapshot().session.status === 'ready' ||
        host.snapshot().session.status === 'running'
      ) {
        for (const event of rooms?.pending() ?? []) {
          try {
            const receipt = commandStatusSchema.parse(
              await request(`${sessionPath}/room-message`, {
                ...hostLease,
                room_id: event.roomId,
                message_id: event.messageId,
                sequence: event.sequence,
                missed_count: event.missed,
                gap_reason: event.gap?.reason ?? null,
              })
            );
            if (receipt.status === 'unknown' || receipt.status === 'rejected')
              await host.notice(
                `Room message ${event.messageId}: ${receipt.message ?? receipt.status}. It was not resent.`
              );
          } catch (error) {
            if (
              !(error instanceof RequestError) ||
              ![
                'UNSUPPORTED_CAPABILITY',
                'ROOM_MESSAGE_RESERVED',
                'ROOM_EVENT_UNAVAILABLE',
                'ROOM_REPLAY_REFUSED',
                'NOT_AUTHORIZED',
              ].includes(error.code)
            )
              throw error;
            const noticeKey = JSON.stringify([event.roomId, event.messageId, 'delivery']);
            const lastNotice = noticeAttempts.get(noticeKey);
            if (
              error.code === 'ROOM_EVENT_UNAVAILABLE' &&
              lastNotice !== undefined &&
              performance.now() - lastNotice < 1000
            )
              continue;
            if (!localDeliveryNotices.has(noticeKey)) {
              await host.notice(
                `Room message ${event.messageId} was not submitted: ${error.message}. Read the room context before continuing.`
              );
              localDeliveryNotices.add(noticeKey);
            }
            if (
              error.code === 'ROOM_EVENT_UNAVAILABLE' &&
              options.roomConnection &&
              rooms!
                .unreportedFailures('delivery')
                .some(
                  (pending) =>
                    pending.roomId === event.roomId && pending.messageId === event.messageId
                )
            ) {
              noticeAttempts.set(noticeKey, performance.now());
              try {
                await requestOnce(
                  `${sessionPath}/room-failure`,
                  {
                    ...hostLease,
                    connection_id: options.roomConnection.connectionId,
                    room_id: event.roomId,
                    message_id: event.messageId,
                    reason: 'delivery',
                  },
                  AbortSignal.timeout(5000)
                );
                await rooms!.markFailureNotified(event, 'delivery');
              } catch (noticeError) {
                console.error(
                  'Could not report the unverified message to the room:',
                  String(noticeError)
                );
                if (noticeError instanceof RequestError && noticeError.code === 'HOST_NOT_OWNER')
                  throw noticeError;
                if (!(noticeError instanceof RequestError)) continue;
              }
            }
          }
          await rooms!.acknowledge(event);
        }
      }
      const commands = await request(`${sessionPath}/commands`, hostLease);
      if (!Array.isArray(commands)) throw new Error('Switch returned an invalid command batch.');
      for (const value of commands) {
        executionSignal.throwIfAborted();
        if (performance.now() >= deadline) {
          if (lease) throw new SharedHostLeaseExpiredError();
          throw new Error(
            'HOST_START_TIMEOUT: Switch did not grant a session lease within 30 seconds. Check the server address and connectivity.'
          );
        }
        const command = commandSchema.parse(value);
        if (command.sessionId !== session.sessionId)
          throw new Error('Switch returned a command for another session.');
        if (command.epoch !== hostLease.epoch) continue;
        try {
          if (command.body.type === 'session.compact') {
            let finished = false;
            const pending = host.command(command).finally(() => {
              finished = true;
            });
            void pending.catch(() => {});
            while (!finished) {
              await flush();
              await delay(250, undefined, { signal: executionSignal });
            }
            await pending;
          } else await host.command(command);
        } catch (error) {
          await host.reject(command, error);
        }
        await flush();
      }
      await delay(250, undefined, { signal: executionSignal });
    }
  } catch (error) {
    const reason = failure ?? stopped.signal.reason ?? error;
    if (reason instanceof Error && 'code' in reason && reason.code === 'HOST_NOT_OWNER') {
      const pending = (rooms?.pending() ?? []).map(({ roomId, messageId }) => ({
        roomId,
        messageId,
      }));
      let cause: unknown = reason;
      let cleanupFailed = false;
      try {
        await stopExecution();
      } catch (cleanupError) {
        cleanupFailed = true;
        cause = new AggregateError(
          [reason, cleanupError],
          'Ownership was lost and provider cleanup failed.'
        );
      }
      failure = new SharedHostFencedError(pending, cause, cleanupFailed);
      console.error(failure);
      await HostedSession.markFenced(options.root);
    } else if (!signal.aborted) failure ??= reason;
    if (starting && !executionSignal.aborted && delivery) {
      try {
        const events = await Journal.read(join(options.root, 'events.jsonl'), (value) =>
          serverEventSchema.parse(value)
        );
        for (const event of events.filter((event) => event.sequence > delivery!.cursor))
          await delivery.capture(event);
        await upload(false);
      } catch (reportError) {
        console.error('Could not report provider startup failure to Switch:', String(reportError));
      }
    }
    if (starting && !executionSignal.aborted) await reportRoomFailures('startup');
  } finally {
    stopped.abort();
    await heartbeat;
    try {
      await finish();
    } catch (error) {
      if (failure)
        console.warn('Shared host cleanup failed after an earlier error:', String(error));
      failure ??= error;
    }
    executionSignal.removeEventListener('abort', onAbort);
  }
  if (failure) throw failure;
}
