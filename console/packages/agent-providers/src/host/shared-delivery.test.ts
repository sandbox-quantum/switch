import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHostEvent } from '@switch-console/shared/session-v1';
import type { HostEvent, ServerEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it } from 'vitest';
import { SharedDelivery } from './shared-delivery';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const generation = (epoch: string): Session => ({
  sessionId: 'session',
  agentId: 'agent',
  hostId: 'host',
  provider: 'claude',
  epoch,
  status: 'ready',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
});
const session = generation('epoch');
const next = generation('next');
const saved = (sourceSequence: number, hostSequence: number, body: HostEvent['body']) =>
  JSON.stringify({
    type: 'event',
    sourceSequence,
    event: {
      contractVersion: 1,
      eventId: randomUUID(),
      sessionId: session.sessionId,
      epoch: next.epoch,
      hostSequence,
      occurredAt: new Date().toISOString(),
      body,
    },
  }) + '\n';
const deliveryPath = (root: string, epoch: string) =>
  join(root, `delivery-${createHash('sha256').update(epoch).digest('hex')}.jsonl`);
const event = (sequence: number): ServerEvent => ({
  contractVersion: 1,
  sessionId: session.sessionId,
  eventId: randomUUID(),
  sequence,
  occurredAt: new Date().toISOString(),
  body: { type: 'notice', level: 'info', code: 'TEST', message: 'Saved event' },
});

it('replays the same wire event after a crash or a lost acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-delivery-'));
  roots.push(root);
  let delivery = await SharedDelivery.load(root, session);
  await delivery.capture(event(1));
  const pending = delivery.pending();
  delivery = await SharedDelivery.load(root, session);
  expect(delivery.cursor).toBe(1);
  expect(delivery.pending()).toEqual(pending);
  await delivery.acknowledge(1);
  delivery = await SharedDelivery.load(root, session);
  expect(delivery.pending()).toEqual([]);
  await delivery.capture(event(2));
  expect(delivery.pending()[0].hostSequence).toBe(2);
});

it('persists filtered source events without allocating upload positions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-delivery-'));
  roots.push(root);
  let delivery = await SharedDelivery.load(root, session);
  await delivery.capture({
    ...event(1),
    body: { type: 'session.connectivity', connectivity: 'offline' },
  });
  delivery = await SharedDelivery.load(root, session);
  expect(delivery.cursor).toBe(1);
  expect(delivery.pending()).toEqual([]);
  await delivery.capture(event(2));
  expect(delivery.pending()[0].hostSequence).toBe(1);
  await expect(delivery.acknowledge(2)).rejects.toThrow('invalid host event receipt');
  await expect(delivery.capture(event(4))).rejects.toThrow('not contiguous');
  const next = await SharedDelivery.load(root, { ...session, epoch: 'next' }, delivery.cursor);
  await next.capture(event(3));
  expect(next.pending()[0]).toMatchObject({ epoch: 'next', hostSequence: 1 });
  expect((await SharedDelivery.load(root, session)).cursor).toBe(2);
});

it('replaces prior-generation session state with a notice at its upload position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-delivery-'));
  roots.push(root);
  const delivery = await SharedDelivery.load(root, next);
  await delivery.capture({
    ...event(1),
    body: { type: 'session.upsert', session: { ...session, status: 'error' } },
  });
  expect(delivery.cursor).toBe(1);
  expect(delivery.pending()[0]).toMatchObject({
    epoch: next.epoch,
    hostSequence: 1,
    body: {
      type: 'notice',
      level: 'info',
      code: 'PRIOR_GENERATION_STATE_SKIPPED',
      message: `Session state from generation ${session.epoch} was not replayed into generation ${next.epoch}.`,
    },
  });
  await delivery.capture({ ...event(2), body: { type: 'session.upsert', session: next } });
  await delivery.capture(event(3));
  expect(delivery.pending().map((pending) => pending.body.type)).toEqual([
    'notice',
    'session.upsert',
    'notice',
  ]);
  for (const pending of delivery.pending()) expect(parseHostEvent(pending)).toEqual(pending);
});

it('reopens a journal holding prior-generation state without losing the events behind it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-delivery-'));
  roots.push(root);
  await writeFile(
    deliveryPath(root, next.epoch),
    saved(160, 1, { type: 'session.upsert', session: { ...session, status: 'error' } }) +
      saved(161, 2, {
        type: 'notice',
        level: 'error',
        code: 'HOST_ERROR',
        message: 'Reset failed',
      }) +
      saved(162, 3, {
        type: 'command.result',
        commandId: 'reset',
        status: 'unknown',
        code: null,
        message: null,
      })
  );
  const delivery = await SharedDelivery.load(root, next, 159);
  const pending = delivery.pending();
  expect(pending).toHaveLength(3);
  expect(pending[0]).toMatchObject({
    hostSequence: 1,
    body: { type: 'notice', code: 'PRIOR_GENERATION_STATE_SKIPPED' },
  });
  expect(pending.map((event) => event.body.type)).toEqual(['notice', 'notice', 'command.result']);
  for (const event of pending) expect(parseHostEvent(event)).toEqual(event);
  expect(delivery.cursor).toBe(162);
  expect(delivery.throughHostSequence).toBe(3);
});

it('refuses a journal whose saved envelope belongs elsewhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-delivery-'));
  roots.push(root);
  const body: HostEvent['body'] = {
    type: 'session.upsert',
    session: { ...session, status: 'error' },
  };
  await writeFile(deliveryPath(root, next.epoch), saved(1, 1, body).replace(next.epoch, 'other'));
  await expect(SharedDelivery.load(root, next)).rejects.toThrow('invalid event identity');
  await writeFile(deliveryPath(root, next.epoch), saved(1, 2, body));
  await expect(SharedDelivery.load(root, next)).rejects.toThrow('invalid event identity');
  await writeFile(deliveryPath(root, next.epoch), saved(2, 1, body));
  await expect(SharedDelivery.load(root, next)).rejects.toThrow('gap in its source cursor');
});
