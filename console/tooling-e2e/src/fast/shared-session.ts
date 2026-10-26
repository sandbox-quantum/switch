import { expect } from 'vitest';
import type { SharedSessionDetail } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/** What `update_shared_session` and `set_room_session` answer with. */
interface Sharing {
  shared: boolean;
  home_room: { id: string; name: string } | null;
  rooms: { id: string; name: string }[];
  shared_by_default: boolean;
  locked: boolean;
}

/** Each room's mark in the gateway's agent detail. */
const marks = (detail: SharedSessionDetail): Record<string, string | null> =>
  Object.fromEntries(detail.rooms.map((room) => [room.room_id, room.shared_session]));

/**
 * Shared sessions: one session of an agent, based in a home room, answering
 * the rooms that share it. Drives the settings from both of their surfaces:
 *
 * 1. the gateway (what Switch Console's settings call), as the workspace admin
 *    the harness signs in as: base the session in a room, share a second room;
 * 2. the agent operations, as an agent the admin owns (so it acts with the
 *    admin's rights): share and isolate a room, move the home, stop sharing,
 *    and read what each room spent.
 *
 * Who may change the settings (the agent's owner or a workspace admin) is
 * covered by core's unit tests: every agent the harness registers acts for the
 * same admin, so it has no stranger to refuse.
 */
export const sharedSession: FastScenario = {
  header: {
    id: 'shared-session',
    covers: [
      'PUT /gateway/agents/{agent_id}/shared-session',
      'PUT /gateway/agents/{agent_id}/rooms/{room_id}/session',
      'update_shared_session',
      'set_room_session',
      'get_room_usage',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient, log }) {
    const lead = await fixtures.agent('lead');
    const hub = await fixtures.internalRoom('hub', [lead]);
    const work = await fixtures.internalRoom('work', [lead]);
    const side = await fixtures.internalRoom('side', [lead]);

    // ── the gateway, as the admin ───────────────────────────────────────────
    let detail = await switchClient.updateSharedSession(lead.id, {
      homeRoomId: hub.id,
      sharedByDefault: true,
    });
    expect(detail.home_room_id).toBe(hub.id);
    expect(detail.shared_by_default).toBe(true);
    expect(marks(detail)[hub.id]).toBe('home');

    detail = await switchClient.setRoomSession(lead.id, work.id, true);
    expect(marks(detail)).toMatchObject({ [hub.id]: 'home', [work.id]: 'shared', [side.id]: null });
    log(`${lead.name} shares one session from ${hub.name} with ${work.name}`);

    // ── the agent operations, as an agent the admin owns ────────────────────
    const buddy = await switchClient.registerAgentAsUser({
      name: names.name('buddy'),
      description: `Switch end-to-end harness agent (run ${names.runId}). Safe to delete.`,
    });
    fixtures.defer(`agent ${buddy.name} (${buddy.id})`, () => switchClient.deleteAgent(buddy));

    let sharing = await switchClient.callOperation<Sharing>(buddy, 'set_room_session', {
      room_id: side.id,
      agent_name: lead.name,
      session: 'shared',
    });
    expect(sharing.home_room?.id).toBe(hub.id);
    expect(sharing.rooms.map((room) => room.id).sort()).toEqual([work.id, side.id].sort());

    sharing = await switchClient.callOperation<Sharing>(buddy, 'set_room_session', {
      room_id: side.id,
      agent_name: lead.name,
      session: 'isolated',
    });
    expect(sharing.rooms.map((room) => room.id)).toEqual([work.id]);

    sharing = await switchClient.callOperation<Sharing>(buddy, 'update_shared_session', {
      agent_name: lead.name,
      home_room_id: work.id,
    });
    expect(sharing.home_room?.id).toBe(work.id);
    // The old home stays shared, as one of its other rooms.
    expect(sharing.rooms.map((room) => room.id)).toEqual([hub.id]);

    const usage = await switchClient.callOperation<{ rooms: unknown[] }>(buddy, 'get_room_usage', {
      agent_name: lead.name,
      days: 1,
    });
    expect(Array.isArray(usage.rooms)).toBe(true);

    sharing = await switchClient.callOperation<Sharing>(buddy, 'update_shared_session', {
      agent_name: lead.name,
      home_room_id: '',
    });
    expect(sharing.shared).toBe(false);
    expect(sharing.home_room).toBeNull();
    log(`${buddy.name} moved the home, isolated a room and stopped the sharing`);
  },
};
