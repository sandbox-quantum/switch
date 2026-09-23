import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  commandSchema,
  heldDeliveriesSchema,
  roomBindingSchema,
  roomMessageReceiptSchema,
  serverEventSchema,
  snapshotSchema,
} from '@switch-console/shared/session-v1';
import type { Command, Session } from '@switch-console/shared/session-v1';
import type { z } from 'zod';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { stageAttachment, MAX_ATTACHMENT_BYTES } from './attachments';
import { declareHandoffCapability, HandoffInbox } from './handoff';
import { Journal } from './journal';
import { SharedRoomInbox, type roomConnectionSchema } from './room-inbox';
import { HostedSession } from './session-host';
import { clearSessionSelector, writeSessionSelector } from './shared-config';
import { SharedDelivery } from './shared-delivery';
import { SharedState } from './shared-state';

export type SharedHostOptions = {
  root: string;
  resumeOperationId?: string;
  authenticate?: () => Promise<void>;
  agentApiUrl: string;
  token: string;
  session: Session;
  input: ProviderSessionStartInput;
  roomConnection?: z.infer<typeof roomConnectionSchema>;
  grant?: { roomId: string; messageId: string };
};

class TransportError extends Error {}
class RequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * How often a session asks Switch for the room work its own rooms still owe
 * it, rather than waiting for its controller to hand it over.
 *
 * A session whose controller has gone is still the session the server says is
 * in the room, and nothing is left to route to it; this is how it finds that
 * work anyway. The interval is a placeholder to be measured, not a tuned
 * number: it trades how long such a session stays silent against a request per
 * session per interval on a server where every controller is healthy and the
 * answer is almost always empty.
 */
const ROOM_PULL_MS = 5000;
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
      throw new RequestError(
        code,
        response.status,
        `Switch session request failed (${response.status}): ${text}`
      );
    }
    return response.json();
  };
  /**
   * One attempt, behind the same fences as a retried one.
   *
   * Abort and the lease deadline are checked here rather than in the retry
   * loop, so a caller that would rather come back later than wait still
   * cannot talk to Switch on a lease this host no longer holds.
   */
  const attempt = async (path: string, body: unknown): Promise<unknown> => {
    executionSignal.throwIfAborted();
    if (performance.now() >= deadline) {
      if (lease) throw new SharedHostLeaseExpiredError();
      throw new Error(
        'HOST_START_TIMEOUT: Switch did not grant a session lease within 30 seconds. Check the server address and connectivity.'
      );
    }
    return requestOnce(path, body, executionSignal);
  };
  const request = async (path: string, body: unknown): Promise<unknown> => {
    let disconnected = false;
    while (true) {
      try {
        const result = await attempt(path, body);
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
    await clearSessionSelector(options.root);
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
          // The room this session was started to answer, so the server creates
          // it already holding that room. Spent once: a grant the server has
          // since given to another session, or let lapse, refuses the claim
          // rather than producing a second session for one room.
          grant: options.grant && {
            room_id: options.grant.roomId,
            message_id: options.grant.messageId,
          },
        })
      );
      await state.journal.append({ type: 'lease', snapshot, sourceBase: 0 });
    }
    lease = state.latest('lease')!;
    const session = structuredClone(lease.snapshot.session);
    const hostLease = { host_id: session.hostId, epoch: session.epoch };
    // The room set the session is bound to, as the server last answered it,
    // and null until it has been told at all. The selector the runtime sends
    // resolves through that binding, so nothing is published before it exists.
    let roomBinding: string | null = null;
    let boundAt = 0;
    let unreachable = false;
    let disclosed = false;
    const publishSelector = () =>
      writeSessionSelector(options.root, {
        session_id: options.session.sessionId,
        host_id: hostLease.host_id,
        epoch: hostLease.epoch,
      });
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
    let rooms: SharedRoomInbox | null = null;
    let handoffs: HandoffInbox | null = null;
    // Names the connection this session's room events arrive over, and answers
    // with the rooms the server has it serving. Re-asserted while the session
    // runs, because the connection belongs to the agent's controller, which can
    // go away and come back under the same identity while this session keeps
    // running — the binding is how the session finds out either way.
    const roomConnection = options.roomConnection;
    const bindRoomConnection = async () => {
      boundAt = performance.now();
      const served = roomBindingSchema.parse(
        await request(`${sessionPath}/room-connection`, {
          ...hostLease,
          connection_id: roomConnection!.connectionId,
        })
      ).rooms;
      const current = JSON.stringify(served);
      if (current === roomBinding) return;
      await rooms!.serves(served);
      roomBinding = current;
      await publishSelector();
    };
    /**
     * Binds, and survives a refusal rather than taking the session down with
     * it.
     *
     * The events are held by the server until something reaches them, and the
     * identity this binding names is derived from the agent rather than minted
     * per run, so a controller that comes back is the same one and delivery
     * resumes on its own. What is not allowed is going quietly deaf, so the
     * refusal is said in the transcript — and said there even when it happened
     * before there was a transcript to say it in, which is the ordinary case
     * when a restore brings a session up before its controller.
     */
    const assertRoomBinding = async (): Promise<void> => {
      try {
        await bindRoomConnection();
      } catch (error) {
        if (!(error instanceof RequestError) || error.code !== 'NOT_AUTHORIZED') throw error;
        if (!unreachable) {
          unreachable = true;
          console.warn(error.message);
        }
        await discloseRefusal();
        return;
      }
      if (!unreachable) return;
      unreachable = false;
      disclosed = false;
      await host?.roomDeliveryResumed();
    };
    let pulledAt: number | null = null;
    let pullUnanswered = false;
    let pullFailing = false;
    const givenUpOn = new Set<string>();
    /**
     * Ask Switch for the deliveries this session's own rooms still owe it.
     *
     * The push is the fast path and stays the fast path: this exists for the
     * session whose controller is not there to push. It is the same work
     * either way — the server hands out one delivery per room, the one it
     * would accept next, and the inbox admits each message once however many
     * times it is offered, so a delivery that arrives both ways is journaled,
     * run and acknowledged once.
     *
     * A delivery the room has moved away from is not offered here at all: the
     * answer is filtered by the rooms the server has this session holding, so
     * one this session gave back does not come round again until the room
     * does — at which point it has still never been made.
     *
     * Asking is an addition, not a dependency. A server that does not answer
     * is said once and not asked again; one that refuses is said and asked
     * again next time, and in both cases the controller's route is untouched.
     *
     * Which is why this asks once and comes back rather than retrying until
     * it gets an answer. The loop this runs in is also what drains the
     * handoffs the controller writes and what submits and acknowledges what
     * it has run: waiting here for a route that is only the second way to the
     * same work would stop the first one.
     */
    const pullOwedDeliveries = async (inbox: SharedRoomInbox): Promise<void> => {
      if (pullUnanswered || (pulledAt !== null && performance.now() - pulledAt < ROOM_PULL_MS))
        return;
      pulledAt = performance.now();
      let owed: z.infer<typeof heldDeliveriesSchema>;
      try {
        owed = heldDeliveriesSchema.parse(
          await attempt(`${sessionPath}/room-reservations`, hostLease)
        );
      } catch (error) {
        if (executionSignal.aborted || error instanceof SharedHostLeaseExpiredError) throw error;
        if (error instanceof RequestError && error.status === 404) {
          pullUnanswered = true;
          console.warn(
            `This Switch server does not answer a session's own room work, so room messages reach this session only while its controller is routing them: ${error.message}`
          );
          return;
        }
        // Reported and survived rather than raised. What is owed is also being
        // pushed wherever a controller is up, and taking a working session
        // down because the second route to the same work is unreadable would
        // cost more than the route is worth.
        if (!pullFailing) {
          pullFailing = true;
          console.warn(
            `Switch would not say what room work this session is owed: ${String(error)}`
          );
        }
        return;
      }
      pullFailing = false;
      for (const held of owed) {
        if (held.expired) {
          const key = `${held.room_id}:${held.message_id}`;
          if (givenUpOn.has(key)) continue;
          givenUpOn.add(key);
          await host?.notice(
            `Room message ${held.message_id} was held for this session longer than Switch promises to hold one, and has not been delivered. Nothing was sent to the room about it.`
          );
          continue;
        }
        await inbox.accept({
          sequence: held.sequence,
          roomId: held.room_id,
          messageId: held.message_id,
        });
      }
    };
    const discloseRefusal = async (): Promise<void> => {
      if (disclosed || !host) return;
      disclosed = true;
      await host.notice(
        "This session is not bound to its agent's room connection, so messages addressed to it in Switch are not reaching it. Delivery resumes by itself once that connection is back; if it does not, restart the agent's room watcher."
      );
    };
    if (roomConnection) {
      rooms = await SharedRoomInbox.open(options.root);
      // Before the binding, which is what answers a room this session already
      // holds: an event its controller routes here as soon as that answer
      // lands waits in the inbox, rather than being written to a worker that
      // had not yet said it reads one.
      await declareHandoffCapability(options.root);
      handoffs = new HandoffInbox(options.root);
      handoffs.listen(executionSignal);
      await assertRoomBinding();
    }
    starting = true;
    host = await HostedSession.start(
      options.root,
      {
        session,
        input: options.input,
        epochAuthority: 'server',
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
            if (roomBinding !== null) await publishSelector();
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
    let heldForDecision = false;
    // A refusal from before the provider existed had no transcript to be said
    // in; this is the first moment there is one.
    if (unreachable) await discloseRefusal();
    while (!executionSignal.aborted) {
      await flush();
      if (roomConnection && performance.now() - boundAt >= 5000) await assertRoomBinding();
      if (host.snapshot().session.status === 'stopped') break;
      if (host.snapshot().session.status === 'error' && !host.resetDecisionPending)
        throw new Error(
          'HOST_FAULTED: Provider execution failed. The room connection is closing; inspect the transcript before recovery.'
        );
      if (host.resetDecisionPending) heldForDecision = true;
      else if (heldForDecision) {
        heldForDecision = false;
        const held = rooms?.pending().length ?? 0;
        if (held) {
          await host.roomBacklogDelivered(held);
          await flush();
        }
      }
      const admitted: Command[] = [];
      if (
        host.snapshot().session.status === 'ready' ||
        host.snapshot().session.status === 'running'
      ) {
        if (rooms) await pullOwedDeliveries(rooms);
        if (rooms && handoffs)
          for (const event of await handoffs.drain()) await rooms.accept(event);
        for (const event of rooms?.pending() ?? []) {
          try {
            const receipt = roomMessageReceiptSchema.parse(
              // Asked for in the query string: a server built before this
              // existed ignores an unknown parameter there, while the request
              // body is strict and an unknown field in it is a 422 the host
              // cannot recover from. Such a server answers the plain receipt,
              // which carries no command, and this falls back to the fetch.
              await request(`${sessionPath}/room-message?include_command=true`, {
                ...hostLease,
                room_id: event.roomId,
                message_id: event.messageId,
                sequence: event.sequence,
              })
            );
            if (receipt.command) admitted.push(receipt.command);
            if (receipt.status === 'unknown' || receipt.status === 'rejected')
              await host.notice(
                `Room message ${event.messageId}: ${receipt.message ?? receipt.status}. It was not resent.`
              );
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            // The room moved to another session of this agent while the event
            // was on its way here. Switch keeps the delivery and hands it to
            // whoever holds the room now, so this session lets it go rather
            // than retrying something it is no longer entitled to submit.
            // Given back rather than acknowledged: the delivery was never
            // made, the room can come back here, and an acknowledgement would
            // refuse it the second time as though it had been.
            if (error.code === 'ROOM_MESSAGE_REASSIGNED') {
              await host.notice(
                `Room message ${event.messageId} is no longer this session's to answer; the room moved to another session of this agent, and Switch is delivering the message there.`
              );
              await rooms!.release(event);
              continue;
            }
            // An earlier message for this room has not been answered yet, so
            // this one is not this session's to run first. Kept outstanding
            // and not given back: nothing has changed about whose delivery it
            // is, only about when. The one in front of it is already held or
            // arrives with the next pull, and this is tried again behind it.
            if (error.code === 'ROOM_MESSAGE_OUT_OF_ORDER') continue;
            if (
              [
                'UNSUPPORTED_CAPABILITY',
                'ROOM_MESSAGE_RESERVED',
                'ROOM_MESSAGE_ABANDONED',
              ].includes(error.code)
            )
              await host.notice(
                `Room message ${event.messageId} was not submitted: ${error.message}`
              );
            else throw error;
          }
          await rooms!.acknowledge(event);
        }
      }
      // A command handed back by its own admission needs no fetching. The
      // server hands one back only while nothing else is queued for the
      // session, so running it here cannot put it ahead of a stop, a reset or
      // an interrupt that was waiting: with any of those pending the receipt
      // carries no command and this falls through to the ordered endpoint.
      // Anything queued after the admission is served by the next pass, as a
      // command arriving just after a fetch always has been.
      const commands =
        admitted.length > 0 ? admitted : await request(`${sessionPath}/commands`, hostLease);
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
      if (handoffs) await handoffs.idle(250, executionSignal);
      else await delay(250, undefined, { signal: executionSignal });
    }
  } catch (error) {
    if (!signal.aborted) failure ??= error;
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
