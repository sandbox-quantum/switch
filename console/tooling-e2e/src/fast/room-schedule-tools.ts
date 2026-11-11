import { expect } from 'vitest';
import { SwitchHttpError } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

interface AgentSchedule {
  id: string;
  agents: string[];
  text: string;
  paused: boolean;
  next_run_at: string | null;
  set_up_by_you: boolean;
}

/**
 * An agent managing a room's schedules through its Switch tools: an agent
 * whose owner manages the room sets one up for itself, lists it as its own,
 * changes, pauses and deletes it, and the room's page shows which agent set it
 * up. An agent whose owner may not manage the room is refused.
 */
export const roomScheduleTools: FastScenario = {
  header: {
    id: 'room-schedule-tools',
    covers: [
      'create_room_schedule',
      'list_room_schedules',
      'update_room_schedule',
      'pause_room_schedule',
      'delete_room_schedule',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, switchClient, log }) {
    // The room is the signed-in admin's, so the admin's agent may manage it.
    const minder = await fixtures.agent('minder', { ownedByAdmin: true });
    const stranger = await fixtures.agent('stranger');
    const room = await fixtures.internalRoom('room', [minder, stranger]);
    const call = <T>(agent: typeof minder, operation: string, args: Record<string, unknown>) =>
      switchClient.callOperation<T>(agent, operation, args);
    const daily = { timezone: 'Europe/London', cron: '0 9 * * *' };

    const made = await call<AgentSchedule>(minder, 'create_room_schedule', {
      room_id: room.id,
      agents: [minder.name],
      text: 'Check the overnight build.',
      ...daily,
    });
    expect(made.agents).toEqual([minder.name]);
    expect(made.set_up_by_you).toBe(true);
    expect(made.next_run_at).not.toBeNull();
    log(`agent schedule ${made.id} set up`);

    const listed = await call<AgentSchedule[]>(minder, 'list_room_schedules', {
      room_id: room.id,
    });
    expect(listed.map((s) => [s.id, s.set_up_by_you])).toEqual([[made.id, true]]);
    const [seen] = await switchClient.listSchedules(room.id);
    expect(seen?.id).toBe(made.id);

    const edited = await call<AgentSchedule>(minder, 'update_room_schedule', {
      room_id: room.id,
      schedule_id: made.id,
      agents: [minder.name],
      text: 'Check the overnight build and the flaky tests.',
      ...daily,
    });
    expect(edited.text).toBe('Check the overnight build and the flaky tests.');
    const paused = await call<AgentSchedule>(minder, 'pause_room_schedule', {
      room_id: room.id,
      schedule_id: made.id,
      paused: true,
    });
    expect(paused.paused).toBe(true);

    // The other agent's owner does not manage the room.
    try {
      await call(stranger, 'create_room_schedule', {
        room_id: room.id,
        agents: [stranger.name],
        text: 'Not allowed.',
        ...daily,
      });
      throw new Error('an agent whose owner may not manage the room set up a schedule');
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status).toBe(403);
    }

    await call(minder, 'delete_room_schedule', { room_id: room.id, schedule_id: made.id });
    expect(await switchClient.listSchedules(room.id)).toEqual([]);
  },
};
