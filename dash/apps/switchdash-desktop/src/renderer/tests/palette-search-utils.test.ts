import { describe, expect, it } from 'vitest';
import {
  applyContextAffinity,
  matchHosts,
  matchRooms,
  matchServers,
} from '@renderer/features/command-palette/search-utils';
import type { SearchItem } from '@shared/core/search';
import type { RemoteRoomSummary, SwitchServer } from '@shared/core/switch-servers/switch-servers';

function room(over: Pick<RemoteRoomSummary, 'id' | 'name'>): RemoteRoomSummary {
  return {
    description: '',
    channelType: null,
    agentCount: 0,
    bridgeDisplayName: null,
    bridgeType: null,
    externalChannelUrl: null,
    ownerId: null,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as RemoteRoomSummary;
}

const ROOMS = [
  room({ id: 'r1', name: 'switchdash search bar' }),
  room({ id: 'r2', name: 'Switch Workforce hub' }),
  room({ id: 'r3', name: 'release engineering' }),
];

describe('matchRooms', () => {
  it('returns nothing for an empty query rather than every room', () => {
    expect(matchRooms(ROOMS, '')).toEqual([]);
    expect(matchRooms(ROOMS, '   ')).toEqual([]);
  });

  it('matches case-insensitively on a substring', () => {
    expect(matchRooms(ROOMS, 'WORKFORCE').map((r) => r.id)).toEqual(['r2']);
  });

  // Rooms are matched in the renderer, so they are not subject to the trigram
  // tokenizer's three-character floor that the indexed kinds are.
  // No trigram tokenizer here, so there is no three-character floor.
  it('answers a one- and two-character query', () => {
    expect(matchRooms(ROOMS, 'se').map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('matches mid-word, so a term inside a compound name is still found', () => {
    expect(matchRooms(ROOMS, 'dash').map((r) => r.id)).toEqual(['r1']);
    expect(matchRooms(ROOMS, 'lease').map((r) => r.id)).toEqual(['r3']);
  });

  it('matches a word after a separator', () => {
    expect(matchRooms(ROOMS, 'bar').map((r) => r.id)).toEqual(['r1']);
    expect(matchRooms(ROOMS, 'hub').map((r) => r.id)).toEqual(['r2']);
  });

  // The whole query is one substring: a hyphen is part of a name here, not a
  // separator between two independently-matched terms.
  it('treats a hyphenated query as one string, not two terms', () => {
    const hosts = [room({ id: 'want', name: 'test-tt' }), room({ id: 'noise', name: 'co-test' })];
    expect(matchRooms(hosts, 'test-tt').map((r) => r.id)).toEqual(['want']);
  });

  it('ranks a name that starts with the query above one that contains it', () => {
    const hits = matchRooms(
      [room({ id: 'mid', name: 'the search bar' }), room({ id: 'start', name: 'search bar' })],
      'search'
    );
    expect(hits.map((h) => h.id)).toEqual(['start', 'mid']);
  });

  it('ranks a name that starts with the query above one that merely contains it', () => {
    const hits = matchRooms(
      [
        room({ id: 'contains', name: 'the search bar' }),
        room({ id: 'starts', name: 'search bar' }),
      ],
      'search'
    );
    expect(hits.map((h) => h.id)).toEqual(['starts', 'contains']);
  });

  it('emits palette items that navigate by room id', () => {
    const [hit] = matchRooms(ROOMS, 'workforce');
    expect(hit).toMatchObject({
      kind: 'room',
      id: 'r2',
      title: 'Switch Workforce hub',
      locationId: null,
    });
  });

  it('caps how much of the palette rooms can take', () => {
    const many = Array.from({ length: 30 }, (_, i) => room({ id: `r${i}`, name: `room ${i}` }));
    expect(matchRooms(many, 'room').length).toBeLessThanOrEqual(8);
  });
});

function server(over: Pick<SwitchServer, 'id' | 'name'> & Partial<SwitchServer>): SwitchServer {
  return {
    gatewayUrl: 'https://gateway.example',
    apiUrl: 'https://api.example',
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as SwitchServer;
}

describe('matchServers', () => {
  const SERVERS = [
    server({ id: 's1', name: 'production' }),
    server({ id: 's2', name: 'staging', gatewayUrl: 'https://switch.internal' }),
  ];

  it('matches on name', () => {
    expect(matchServers(SERVERS, 'stag').map((s) => s.id)).toEqual(['s2']);
  });

  // A server is as often recognised by where it lives as by what it was called.
  it('matches on gateway URL when the name does not match', () => {
    expect(matchServers(SERVERS, 'internal').map((s) => s.id)).toEqual(['s2']);
  });

  it('returns nothing for an empty query', () => {
    expect(matchServers(SERVERS, '')).toEqual([]);
  });

  it('emits palette items carrying the server id', () => {
    expect(matchServers(SERVERS, 'production')[0]).toMatchObject({
      kind: 'server',
      id: 's1',
      title: 'production',
    });
  });
});

describe('matchHosts', () => {
  const HOSTS = [
    { sshHost: 'gpu-box', name: 'GPU box' },
    { sshHost: 'build-01', name: 'Build machine' },
  ];

  it('matches on the display name', () => {
    expect(matchHosts(HOSTS, 'build').map((h) => h.id)).toEqual(['build-01']);
    expect(matchHosts(HOSTS, 'build mach').map((h) => h.id)).toEqual(['build-01']);
    expect(matchHosts(HOSTS, 'nonesuch')).toEqual([]);
  });

  // The SSH alias is the host's identity and usually what someone remembers.
  it('matches on the SSH alias', () => {
    expect(matchHosts(HOSTS, 'gpu-box').map((h) => h.id)).toEqual(['gpu-box']);
  });

  it('identifies the item by its SSH alias, which is the primary key', () => {
    expect(matchHosts(HOSTS, 'gpu')[0]).toMatchObject({
      kind: 'host',
      id: 'gpu-box',
      title: 'GPU box',
      subtitle: 'gpu-box',
    });
  });

  it('returns nothing for an empty query', () => {
    expect(matchHosts(HOSTS, '')).toEqual([]);
  });
});

describe('applyContextAffinity', () => {
  const item = (over: Partial<SearchItem> & Pick<SearchItem, 'id'>): SearchItem => ({
    kind: 'session',
    locationId: null,
    sessionId: null,
    title: over.id,
    subtitle: '',
    score: 0,
    ...over,
  });

  it('puts items from the active location first', () => {
    const ranked = applyContextAffinity(
      [
        item({ id: 'elsewhere', locationId: 'loc-2', score: -5 }),
        item({ id: 'here', locationId: 'loc-1', score: -1 }),
      ],
      { locationId: 'loc-1' }
    );
    expect(ranked.map((r) => r.id)).toEqual(['here', 'elsewhere']);
  });

  it('falls back to BM25 order, where more negative is better', () => {
    const ranked = applyContextAffinity(
      [item({ id: 'weak', score: -1 }), item({ id: 'strong', score: -9 })],
      {}
    );
    expect(ranked.map((r) => r.id)).toEqual(['strong', 'weak']);
  });

  it('does not mutate the array it is given', () => {
    const items = [item({ id: 'b', score: -1 }), item({ id: 'a', score: -9 })];
    applyContextAffinity(items, {});
    expect(items.map((i) => i.id)).toEqual(['b', 'a']);
  });
});
