import { expect } from 'vitest';
import { SwitchHttpError, errorDetail } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

interface RoomGroup {
  id: string;
  name: string;
  parent_group_id: string | null;
  path: string;
  member_rooms: { id: string; name: string }[];
}

/**
 * Room groups named by path: the same subgroup name under two parents is
 * allowed, a bare name that two groups share is refused naming the path of
 * each, the path picks one, and a second group of that name under the same
 * parent is refused whatever its case.
 */
export const roomGroupPaths: FastScenario = {
  header: {
    id: 'room-group-paths',
    covers: [
      'create_room_group',
      'get_room_group_detail',
      'create_room',
      'DELETE /gateway/room-groups/{group_id}',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient, log }) {
    const agent = await fixtures.agent('grp');
    const call = <T>(operation: string, args: Record<string, unknown>): Promise<T> =>
      switchClient.callOperation<T>(agent, operation, args);
    const group = async (name: string, parent: string | null): Promise<RoomGroup> => {
      const made = await call<RoomGroup>('create_room_group', {
        name,
        description: `Switch end-to-end harness (run ${names.runId}). Safe to delete.`,
        ...(parent === null ? {} : { parent_group_name: parent }),
      });
      fixtures.defer(`room group ${made.path} (${made.id})`, () =>
        switchClient.deleteRoomGroup(made.id)
      );
      return made;
    };
    const refusal = async (operation: string, args: Record<string, unknown>): Promise<string> => {
      try {
        await call(operation, args);
      } catch (error) {
        if (error instanceof SwitchHttpError && error.status === 400)
          return errorDetail(error.body);
        throw error;
      }
      throw new Error(`${operation} ${JSON.stringify(args)} was accepted`);
    };

    const parents = [await group(names.name('ga'), null), await group(names.name('gb'), null)];
    // One name, used under both parents: what made bare names ambiguous.
    const child = names.name('inc');
    const children = [];
    for (const parent of parents) {
      const made = await group(child, parent.name);
      expect(made.parent_group_id).toBe(parent.id);
      // Shown spaced ("a / b"); a reference may be written either way.
      expect(made.path.split('/').map((segment) => segment.trim())).toEqual([parent.name, child]);
      children.push(made);
    }
    const [first, second] = children as [RoomGroup, RoomGroup];
    const [firstPath, secondPath] = parents.map((parent) => `${parent.name}/${child}`) as [
      string,
      string,
    ];

    const duplicate = await refusal('create_room_group', {
      name: child.toUpperCase(),
      parent_group_name: parents[0]!.name,
    });
    expect(duplicate).toContain('already exists');

    const room = names.name('room');
    const roomArgs = {
      name: room,
      description: `Switch end-to-end harness (run ${names.runId}). Safe to delete.`,
      agent_names: [agent.name],
      internal_only: true,
    };
    const ambiguous = await refusal('create_room', { ...roomArgs, group_name: child });
    expect(ambiguous).toContain(`Ambiguous room group '${child}'`);
    expect(ambiguous).toContain(firstPath);
    expect(ambiguous).toContain(secondPath);
    log(`a bare '${child}' was refused: ${ambiguous}`);

    const made = await call<{ id: string }>('create_room', { ...roomArgs, group_name: secondPath });
    fixtures.defer(`room ${room} (${made.id})`, () => switchClient.deleteRoom(made.id));
    const detail = await call<RoomGroup>('get_room_group_detail', { group_id: second.id });
    expect(detail.member_rooms).toEqual([{ id: made.id, name: room }]);
    const other = await call<RoomGroup>('get_room_group_detail', { group_id: first.id });
    expect(other.member_rooms).toEqual([]);
  },
};
