import { expect } from 'vitest';
import type { AgentRoomMembership } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * Several agents' rooms in one request: each agent is listed once, in the
 * order asked, with its rooms as its own detail lists them, and an id with no
 * agent behind it is left out.
 *
 * Only the rooms this scenario makes are compared. A messaging app may add a
 * new agent's bot to its default channels, and the bridge records those rooms
 * whenever the join arrives, so the rest can change between two reads.
 */
export const agentRooms: FastScenario = {
  header: {
    id: 'agent-rooms',
    covers: ['GET /gateway/agents/rooms', 'GET /gateway/agents/{agent_id}'],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, switchClient, log }) {
    const first = await fixtures.agent('ar-a');
    const second = await fixtures.agent('ar-b');
    const shared = await fixtures.internalRoom('ar-shared', [first, second]);
    const own = await fixtures.internalRoom('ar-own', [first]);
    const ours = (rooms: AgentRoomMembership[]): AgentRoomMembership[] =>
      rooms
        .filter((room) => room.roomId === shared.id || room.roomId === own.id)
        .sort((a, b) => a.roomId.localeCompare(b.roomId));

    const listed = await switchClient.roomsOfAgents([second.id, 'no-such-agent', first.id]);

    expect(listed.map((entry) => entry.agentId)).toEqual([second.id, first.id]);
    const roomsOf = (agentId: string): string[] =>
      ours(listed.find((entry) => entry.agentId === agentId)?.rooms ?? []).map(
        (room) => room.roomId
      );
    expect(roomsOf(first.id)).toEqual([shared.id, own.id].sort());
    expect(roomsOf(second.id)).toEqual([shared.id]);
    for (const entry of listed) {
      expect(ours(entry.rooms)).toEqual(ours(await switchClient.agentDetailRooms(entry.agentId)));
    }
    log(`read ${listed.length} agents' rooms in one request`);
  },
};
