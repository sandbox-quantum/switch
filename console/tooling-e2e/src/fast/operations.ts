import { expect } from 'vitest';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * The agent-operations front door over HTTP: the same registry the MCP server
 * serves, called the way a session host's tools are.
 */
export const operationsFrontDoor: FastScenario = {
  header: {
    id: 'operations-front-door',
    covers: [
      'GET /agents/{agent_id}/ops',
      'POST /agents/{agent_id}/ops/{operation}',
      'list_rooms',
      'read_context',
    ],
    needsProvider: false,
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient }) {
    const agent = await fixtures.agent('ops');
    const peer = await fixtures.agent('peer');
    const room = await fixtures.internalRoom('room', [agent, peer]);

    const operations = await switchClient.listOperations(agent);
    expect(operations).toEqual(
      expect.arrayContaining(['list_rooms', 'read_context', 'post_message'])
    );

    const rooms = await switchClient.callOperation<{ room_id: string; name: string }[]>(
      agent,
      'list_rooms',
      {}
    );
    expect(rooms).toContainEqual(expect.objectContaining({ room_id: room.id, name: room.name }));

    const marker = names.marker('ops');
    await switchClient.sendMessage(peer, room.id, marker);
    const context = await switchClient.callOperation<{
      threads: { root: { body: string; sender_name: string } }[];
    }>(agent, 'read_context', { room_id: room.id, limit: 20 });
    expect(context.threads.map((thread) => thread.root)).toContainEqual(
      expect.objectContaining({ body: marker, sender_name: peer.name })
    );
  },
};
