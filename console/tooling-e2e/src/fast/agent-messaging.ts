import { expect } from 'vitest';
import { eventText, sleep } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * Agent-to-agent messaging in a room with no bridge: the core of the bus with
 * nothing in front of it. Two throwaway agents, one internal-only room, the
 * harness acting as both.
 */

const NOTIFICATION_DEADLINE_MS = 30_000;

/**
 * An addressed message reaches its recipient's notification stream, carrying
 * the room, the sender, and the addressed flag.
 */
export const addressedDelivery: FastScenario = {
  header: {
    id: 'addressed-delivery',
    covers: [
      'POST /agents/register-known',
      'POST /gateway/rooms',
      'POST /agents/{agent_id}/message',
      'GET /agents/{agent_id}/notifications',
    ],
    needsProvider: false,
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient }) {
    const sender = await fixtures.agent('snd');
    const recipient = await fixtures.agent('rcv');
    const room = await fixtures.internalRoom('room', [sender, recipient]);
    expect(room.agentIds).toEqual(expect.arrayContaining([sender.id, recipient.id]));

    const marker = names.marker('addr');
    const eventId = await switchClient.sendMessage(sender, room.id, `@${recipient.name} ${marker}`);
    expect(eventId).toBeTruthy();

    const { match, seen } = await switchClient.waitForNotification(
      recipient,
      (event) => eventText(event).includes(marker),
      NOTIFICATION_DEADLINE_MS
    );
    expect(
      match,
      `no notification carried ${marker}; saw ${JSON.stringify(seen).slice(0, 800)}`
    ).not.toBeNull();
    expect(match!.type).toBe('message');
    expect(match!.room_id).toBe(room.id);
    expect(match!.payload?.addressed).toBe(true);
    expect(match!.payload?.sender_name).toBe(sender.name);
  },
};

/**
 * Unaddressed messages are history, not notifications: the recipient's room
 * history holds every one of them, in the order they were sent, and its
 * notification stream holds none.
 *
 * Ordering is asserted because the bus promises it — `seq` is assigned under a
 * per-room lock — and a regression there is invisible to every test that sends
 * one message.
 */
export const unaddressedHistory: FastScenario = {
  header: {
    id: 'unaddressed-history',
    covers: [
      'POST /agents/{agent_id}/message',
      'GET /agents/{agent_id}/rooms/{room_id}/history',
      'GET /agents/{agent_id}/notifications',
    ],
    needsProvider: false,
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient }) {
    const sender = await fixtures.agent('snd');
    const reader = await fixtures.agent('rdr');
    const room = await fixtures.internalRoom('room', [sender, reader]);

    const marker = names.marker('chat');
    const sent = Array.from({ length: 5 }, (_, index) => `${marker} #${index + 1}`);
    for (const body of sent) await switchClient.sendMessage(sender, room.id, body);

    let bodies: string[] = [];
    const until = Date.now() + NOTIFICATION_DEADLINE_MS;
    while (Date.now() < until) {
      const history = await switchClient.roomHistory(reader, room.id, 50);
      bodies = history.map((event) => event.body).filter((body) => body.includes(marker));
      if (bodies.length >= sent.length) break;
      await sleep(1_000);
    }
    expect(bodies).toEqual(sent);

    const notified = (await switchClient.pollNotifications(reader, 3)).filter((event) =>
      eventText(event).includes(marker)
    );
    expect(notified, 'an unaddressed message was delivered as a notification').toEqual([]);
  },
};
