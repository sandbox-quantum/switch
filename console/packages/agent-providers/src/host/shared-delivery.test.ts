import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it } from 'vitest';
import { SharedDelivery } from './shared-delivery';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const session = { sessionId: 'session', epoch: 'epoch' } as Session;
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
