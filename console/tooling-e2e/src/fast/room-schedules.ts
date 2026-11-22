import { expect } from 'vitest';
import { eventText } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * A room schedule, end to end on an internal room: a one-off set a moment
 * ahead reaches its agent as an addressed message without anyone writing it,
 * and is not sent again; the same schedule can then be turned into a daily
 * rule, paused, resumed and deleted.
 *
 * The server checks for due runs every few seconds, so the deadline allows for
 * a couple of passes on top of the delivery itself.
 */

const FIRED_DEADLINE_MS = 45_000;

export const roomSchedules: FastScenario = {
  header: {
    id: 'room-schedules',
    covers: [
      'POST /gateway/rooms/{room_id}/schedules',
      'GET /gateway/rooms/{room_id}/schedules',
      'PUT /gateway/rooms/{room_id}/schedules/{schedule_id}',
      'PUT /gateway/rooms/{room_id}/schedules/{schedule_id}/paused',
      'DELETE /gateway/rooms/{room_id}/schedules/{schedule_id}',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient, log }) {
    const agent = await fixtures.agent('sched');
    const room = await fixtures.internalRoom('room', [agent]);
    const marker = names.marker('sched');

    // ── a one-off reaches its agent ──────────────────────────────────────────
    const once = await switchClient.scheduleOnce(
      room.id,
      [agent.id],
      marker,
      new Date(Date.now() + 2_000)
    );
    expect(once.nextRunAt).not.toBeNull();
    expect((await switchClient.listSchedules(room.id)).map((s) => s.id)).toEqual([once.id]);

    const { match, seen } = await switchClient.waitForNotification(
      agent,
      (event) => eventText(event).includes(marker),
      FIRED_DEADLINE_MS
    );
    expect(
      match,
      `no notification carried ${marker}; saw ${JSON.stringify(seen).slice(0, 800)}`
    ).not.toBeNull();
    expect(match!.room_id).toBe(room.id);
    expect(match!.payload?.addressed).toBe(true);
    log(`the one-off reached ${agent.name}`);

    const [sent] = await switchClient.listSchedules(room.id);
    expect(sent!.nextRunAt).toBeNull();
    expect(sent!.lastRunAt).not.toBeNull();

    // ── the same schedule as a daily rule, paused and resumed ───────────────
    const daily = await switchClient.scheduleDaily(
      room.id,
      once.id,
      [agent.id],
      'Post the overnight summary.',
      '0 9 * * *'
    );
    expect(daily.nextRunAt).not.toBeNull();
    expect((await switchClient.pauseSchedule(room.id, once.id, true)).paused).toBe(true);
    const resumed = await switchClient.pauseSchedule(room.id, once.id, false);
    expect(resumed.paused).toBe(false);
    expect(Date.parse(resumed.nextRunAt!)).toBeGreaterThan(Date.now());

    // ── deleted ──────────────────────────────────────────────────────────────
    await switchClient.deleteSchedule(room.id, once.id);
    expect(await switchClient.listSchedules(room.id)).toEqual([]);
  },
};
