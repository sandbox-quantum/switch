import { describe, expect, it } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { appOptions, filterRoomRows, groupOptions, NO_FILTER, roomRow } from './rooms-table';

function room(extra: Partial<RemoteRoomSummary>): RemoteRoomSummary {
  return {
    id: 'r',
    name: 'room',
    description: '',
    channelType: 'channel_public',
    agentCount: 1,
    bridgeDisplayName: 'Acme Slack',
    bridgeType: 'slack',
    externalChannelUrl: null,
    ownerId: 'u-2',
    viewerIsMember: false,
    isConsoleChat: false,
    archived: false,
    createdAt: '2026-10-01T09:00:00Z',
    ...extra,
  };
}

describe('a room as the Rooms table shows it', () => {
  it('names its app, group, owner and access, and counts its agents and people', () => {
    expect(
      roomRow(
        room({
          groupId: 'g1',
          groupName: 'Design',
          ownerName: 'Max Tam',
          readVisibility: 'public',
          writeVisibility: 'private',
          connectedUserCount: 6,
        }),
        'u-1'
      )
    ).toMatchObject({
      appLabel: 'Acme Slack',
      groupName: 'Design',
      ownerLabel: 'Max Tam',
      access: 'read_only',
      agentCount: 1,
      peopleCount: 6,
      privateChannel: false,
    });
  });

  it('calls your own rooms yours, and a private channel private', () => {
    const row = roomRow(room({ ownerId: 'u-1', channelType: 'channel_private' }), 'u-1');
    expect(row.ownerLabel).toBe('You');
    expect(row.privateChannel).toBe(true);
  });

  it('puts a Console chat in Switch Console, private to its members', () => {
    const row = roomRow(
      room({ bridgeType: null, bridgeDisplayName: null, isConsoleChat: true }),
      null
    );
    expect(row).toMatchObject({ appLabel: 'Switch Console', access: 'private' });
  });

  it('says nothing about access a server does not report', () => {
    expect(roomRow(room({}), null).access).toBeNull();
  });
});

describe('filtering the Rooms table', () => {
  const rows = [
    roomRow(room({ id: 'b', name: 'beta', groupId: 'g1', groupName: 'Design' }), null),
    roomRow(room({ id: 'a', name: 'Alpha', bridgeType: null, bridgeDisplayName: null }), null),
    roomRow(
      room({
        id: 'c',
        name: 'gamma',
        bridgeDisplayName: 'Ops Mattermost',
        bridgeType: 'mattermost',
      }),
      null
    ),
  ];

  it('sorts by name and matches the search in any case', () => {
    expect(filterRoomRows(rows, NO_FILTER).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(filterRoomRows(rows, { ...NO_FILTER, query: ' ALP ' }).map((row) => row.id)).toEqual([
      'a',
    ]);
  });

  it('narrows to one app and one group', () => {
    expect(filterRoomRows(rows, { ...NO_FILTER, app: 'Acme Slack' }).map((row) => row.id)).toEqual([
      'b',
    ]);
    expect(filterRoomRows(rows, { ...NO_FILTER, groupId: 'g1' }).map((row) => row.id)).toEqual([
      'b',
    ]);
  });

  it('offers the apps and groups the rows have, Switch Console last', () => {
    expect(appOptions(rows)).toEqual(['Acme Slack', 'Ops Mattermost', 'Switch Console']);
    expect(groupOptions(rows)).toEqual([{ id: 'g1', name: 'Design' }]);
  });
});
