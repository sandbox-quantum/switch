import { expect } from 'vitest';
import type { FastScenario } from './scenario.ts';

/**
 * An agent may not add itself to a room it is not in: changing who is in a
 * room is for its owner, an admin, or a member, so a public room cannot be
 * joined by inviting oneself into it.
 *
 * The outsider is a plain member's agent. One of the harness admin's would be
 * let in, the admin being an operator and the owner of the room. Making a
 * plain member leaves a user behind, so this runs only on ephemeral.
 */
export const outsiderInvite: FastScenario = {
  header: {
    id: 'outsider-invite',
    covers: ['invite_agent_to_room'],
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, switchClient }) {
    const member = await fixtures.agent('in');
    const outsider = await fixtures.plainMemberAgent('out');
    const room = await fixtures.internalRoom('room', [member]);

    const invite = await switchClient.agentAttempt(
      outsider,
      'POST',
      `/agents/${outsider.id}/ops/invite_agent_to_room`,
      { room_id: room.id, agent_name: outsider.name }
    );
    expect(invite, 'an outsider inviting itself into a room').toEqual({
      status: 403,
      detail: "Not authorized to change this room's membership",
    });
    const { agentIds } = await switchClient.getRoom(room.id);
    expect(agentIds, 'the room after the refused invite').toEqual([member.id]);
  },
};
