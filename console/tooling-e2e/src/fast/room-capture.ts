import { expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { WRITABLE, type FastScenario } from './scenario.ts';

/**
 * A room built from a document keeps the packages the document names, and
 * the room captured back as a document builds a second room with the same
 * packages: what a template made from a live room relies on.
 */
export const roomCapture: FastScenario = {
  header: {
    id: 'room-capture',
    covers: [
      'POST /gateway/packages',
      'DELETE /gateway/packages/{package_id}',
      'GET /gateway/rooms/{room_id}/packages',
      'GET /gateway/rooms/{room_id}/yaml',
      'POST /gateway/rooms/from-yaml',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient }) {
    const agent = await fixtures.agent('cap');
    const about = `Switch end-to-end harness (run ${names.runId}). Safe to delete.`;
    const pkg = await switchClient.createPackage({
      name: names.name('pkg'),
      description: about,
      instructions: names.marker('pkg'),
    });
    fixtures.defer(`package ${pkg.name} (${pkg.id})`, () => switchClient.deletePackage(pkg.id));

    const build = async (document: string) => {
      const room = await switchClient.createRoomFromYaml(document);
      fixtures.defer(`room ${room.name} (${room.id})`, () => switchClient.deleteRoom(room.id));
      return room;
    };

    const original = await build(
      stringify({
        room: {
          name: names.name('orig'),
          description: about,
          agents: [agent.name],
          packages: [{ name: pkg.name }],
        },
      })
    );
    expect(await switchClient.roomPackages(original.id)).toMatchObject([
      { id: pkg.id, name: pkg.name },
    ]);

    const captured = parse(await switchClient.exportRoomYaml(original.id)) as {
      room: Record<string, unknown>;
    };
    expect(captured.room.packages).toEqual([{ id: pkg.id }]);
    expect(captured.room.agents).toEqual([agent.name]);

    const copy = await build(stringify({ room: { ...captured.room, name: names.name('copy') } }));
    expect(copy.id).not.toBe(original.id);
    expect(await switchClient.roomPackages(copy.id)).toMatchObject([
      { id: pkg.id, name: pkg.name },
    ]);
  },
};
