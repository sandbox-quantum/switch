import { expect } from 'vitest';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * An agent's mistake is answered with a 4xx that says what was wrong, never a
 * 500: an HTTP agent reads a 500 as the server broken and may retry a request
 * that can never succeed. The server-error check fails the scenario too, if
 * any of these is logged as an error.
 */
export const clientMistakes: FastScenario = {
  header: {
    id: 'client-mistakes',
    covers: [
      'POST /agents/{agent_id}/moderation/rooms/{room_id}/invite',
      'GET /agents/{agent_id}/moderation/rooms/{room_id}',
      'GET /agents/{agent_id}/rooms/{room_id}/history',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, switchClient }) {
    const member = await fixtures.agent('in');
    const outsider = await fixtures.agent('out');
    const room = await fixtures.internalRoom('room', [member]);

    const invite = await switchClient.agentAttempt(
      outsider,
      'POST',
      `/agents/${outsider.id}/moderation/rooms/${room.id}/invite`,
      { agent_name: outsider.name }
    );
    expect(invite, 'an outsider inviting itself into a room').toEqual({
      status: 403,
      detail: "Not authorized to change this room's membership",
    });

    const lookup = await switchClient.agentAttempt(
      outsider,
      'GET',
      `/agents/${outsider.id}/moderation/rooms/${room.id}`,
      null
    );
    expect(lookup, 'an outsider reading a room').toEqual({
      status: 403,
      detail: 'Agent is not a member of this room',
    });

    for (const parameter of ['since', 'before']) {
      const history = await switchClient.agentAttempt(
        member,
        'GET',
        `/agents/${member.id}/rooms/${room.id}/history?${parameter}=yesterday`,
        null
      );
      expect(history, `history with ${parameter}=yesterday`).toEqual({
        status: 400,
        detail: `'${parameter}' is not an ISO 8601 timestamp: 'yesterday'`,
      });
    }
  },
};
