import { describe, expect, it } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import {
  appOptions,
  countText,
  filterRoomCards,
  groupOptions,
  NO_FILTER,
  offeredFilter,
  ownerText,
  roomCard,
} from './room-list';

function room(extra: Partial<RemoteRoomSummary>): RemoteRoomSummary {
  return {
    id: 'r',
    name: 'room',
    description: '',
    channelType: 'channel_public',
    agentCount: 1,
    bridgeId: 'b-acme',
    bridgeDisplayName: 'Acme Slack',
    bridgeType: 'slack',
    externalChannelUrl: null,
    ownerId: 'u-2',
    viewerIsMember: false,
    viewerIsRoomAdmin: false,
    isConsoleChat: false,
    archived: false,
    createdAt: '2026-10-01T09:00:00Z',
    ...extra,
  };
}

const VIEWER = { id: 'u-1' };

describe('a room as the Rooms page shows it', () => {
  it('names its app, group, owner and access, and counts its agents and people', () => {
    const card = roomCard(
      room({
        description: 'Launch checks',
        groupId: 'g1',
        groupName: 'Design',
        ownerName: 'Max Tam',
        readVisibility: 'public',
        writeVisibility: 'private',
        connectedUserCount: 6,
      }),
      VIEWER
    );
    expect(card).toMatchObject({
      description: 'Launch checks',
      appKey: 'b-acme',
      appLabel: 'Acme Slack',
      groupName: 'Design',
      access: 'public',
      agentCount: 1,
      peopleCount: 6,
      privateChannel: false,
    });
    expect(ownerText(card)).toBe('Owned by Max Tam');
  });

  it('says who owns it in words, you included, and nothing when the server does not say', () => {
    expect(ownerText(roomCard(room({ ownerId: 'u-1' }), VIEWER))).toBe('Owned by you');
    expect(ownerText(roomCard(room({ ownerId: null }), VIEWER))).toBeNull();
  });

  it('marks a private channel private', () => {
    expect(roomCard(room({ channelType: 'channel_private' }), VIEWER).privateChannel).toBe(true);
  });

  it('puts a Console chat in Switch Console, private to its members, counting them', () => {
    const card = roomCard(
      room({
        bridgeId: null,
        bridgeType: null,
        bridgeDisplayName: null,
        isConsoleChat: true,
        peopleAreMembers: true,
        connectedUserCount: 3,
      }),
      VIEWER
    );
    expect(card).toMatchObject({
      appLabel: 'Switch Console',
      access: 'private',
      peopleCount: 3,
    });
  });

  it('does not know the people of a room with no app other than a Console chat', () => {
    const card = roomCard(
      room({ bridgeId: null, bridgeType: null, bridgeDisplayName: null, connectedUserCount: 0 }),
      VIEWER
    );
    expect(card.peopleCount).toBeNull();
  });

  it('takes a current server at its word when a Console chat has no members', () => {
    const card = roomCard(
      room({
        bridgeId: null,
        bridgeType: null,
        bridgeDisplayName: null,
        isConsoleChat: true,
        peopleAreMembers: true,
        connectedUserCount: 0,
      }),
      VIEWER
    );
    expect(card.peopleCount).toBe(0);
  });

  it("counts a bridged Console chat's app accounts, as the server does", () => {
    const card = roomCard(room({ isConsoleChat: true, connectedUserCount: 4 }), VIEWER);
    expect(card.peopleCount).toBe(4);
  });

  it('does not know the people of a Console chat on a server that does not count them', () => {
    const card = roomCard(
      room({
        bridgeId: null,
        bridgeType: null,
        bridgeDisplayName: null,
        isConsoleChat: true,
        connectedUserCount: 0,
      }),
      VIEWER
    );
    expect(card).toMatchObject({
      appLabel: 'Switch Console',
      access: 'private',
      peopleCount: null,
    });
  });

  it('says nothing about access a server does not report', () => {
    expect(roomCard(room({}), VIEWER).access).toBeNull();
  });

  it('counts a room as yours when the server says so, or when Console lists it as yours', () => {
    expect(roomCard(room({ viewerIsMember: true }), VIEWER).mine).toBe(true);
    expect(roomCard(room({}), { ...VIEWER, listedIds: new Set(['r']) }).mine).toBe(true);
    expect(roomCard(room({}), VIEWER).mine).toBe(false);
  });

  it('counts a room you own as yours, archived or not, whatever the server says of membership', () => {
    expect(roomCard(room({ ownerId: 'u-1', archived: true }), VIEWER).mine).toBe(true);
    expect(roomCard(room({ ownerId: 'u-1' }), { id: null }).mine).toBe(false);
  });

  it('counts in words', () => {
    expect(countText(1, 'agent', 'agents')).toBe('1 agent');
    expect(countText(0, 'person', 'people')).toBe('0 people');
  });
});

describe('filtering the Rooms page', () => {
  const cards = [
    roomCard(room({ id: 'b', name: 'beta', groupId: 'g1', groupName: 'Design' }), VIEWER),
    roomCard(
      room({ id: 'a', name: 'Alpha', bridgeId: null, bridgeType: null, bridgeDisplayName: null }),
      VIEWER
    ),
    roomCard(
      room({ id: 'c', name: 'gamma', bridgeId: 'b-partners', bridgeDisplayName: 'Partners Slack' }),
      VIEWER
    ),
    // A second connection under the same name as the first: still its own choice.
    roomCard(room({ id: 'd', name: 'delta', bridgeId: 'b-acme-2' }), VIEWER),
  ];

  it('sorts by name and matches the search in any case', () => {
    expect(filterRoomCards(cards, NO_FILTER).map((card) => card.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(filterRoomCards(cards, { ...NO_FILTER, query: ' ALP ' }).map((card) => card.id)).toEqual(
      ['a']
    );
  });

  it('narrows to one app connection and one group', () => {
    expect(filterRoomCards(cards, { ...NO_FILTER, app: 'b-acme' }).map((card) => card.id)).toEqual([
      'b',
    ]);
    expect(filterRoomCards(cards, { ...NO_FILTER, groupId: 'g1' }).map((card) => card.id)).toEqual([
      'b',
    ]);
  });

  it('offers each app connection by its name, with its platform, Switch Console last', () => {
    expect(appOptions(cards)).toEqual([
      { value: 'b-acme', label: 'Acme Slack', bridgeType: 'slack' },
      { value: 'b-acme-2', label: 'Acme Slack', bridgeType: 'slack' },
      { value: 'b-partners', label: 'Partners Slack', bridgeType: 'slack' },
      { value: 'switch-console', label: 'Switch Console', bridgeType: null },
    ]);
    expect(groupOptions(cards)).toEqual([{ id: 'g1', name: 'Design' }]);
  });

  it('drops an app or group no longer offered, keeping the search', () => {
    const picked = { query: 'be', app: 'b-gone', groupId: 'g1' };
    expect(offeredFilter(picked, appOptions(cards), [])).toEqual({
      query: 'be',
      app: null,
      groupId: null,
    });
    expect(
      offeredFilter({ ...picked, app: 'b-acme' }, appOptions(cards), groupOptions(cards))
    ).toEqual({ query: 'be', app: 'b-acme', groupId: 'g1' });
  });
});
