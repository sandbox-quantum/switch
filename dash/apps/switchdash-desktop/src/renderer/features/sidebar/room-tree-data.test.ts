import { describe, expect, it, vi } from 'vitest';
import { UNBRIDGED_FILTER_VALUE } from '@shared/view-state';

const isProvisioned = vi.hoisted(() => vi.fn());
const getSortInstant = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/sessions/stores/session-store', () => ({ isProvisioned }));
vi.mock('./sidebar-store', () => ({ getSortInstant }));

const { bridgeFilterValue, filterRoomGroups, sortRoomGroups } = await import('./room-tree-data');

type TestSession = { id: string; running?: boolean; usedAt?: string };

/** A session stand-in; the rules only ever ask whether it is running and when
 * it was last used, both of which are mocked per test. */
function session(id: string, opts: { running?: boolean; usedAt?: string } = {}) {
  return { id, ...opts } as unknown as never;
}

function group(
  roomKey: string,
  opts: {
    label?: string;
    bridgeType?: string | null;
    createdAt?: string | null;
    sessions?: TestSession[];
  } = {}
) {
  return {
    roomKey,
    label: opts.label ?? roomKey,
    bridgeType: opts.bridgeType ?? null,
    createdAt: opts.createdAt ?? null,
    sessions: (opts.sessions ?? []).map((s) => session(s.id, s)),
  };
}

isProvisioned.mockImplementation((s: TestSession) => s.running === true);
getSortInstant.mockImplementation((s: TestSession) => s.usedAt);

const NO_FILTERS = { bridgeTypes: new Set<string>(), hasLiveSession: false };

describe('bridgeFilterValue', () => {
  it('gives unbridged rooms a value of their own so they stay filterable', () => {
    expect(bridgeFilterValue('slack')).toBe('slack');
    expect(bridgeFilterValue(null)).toBe(UNBRIDGED_FILTER_VALUE);
  });
});

describe('filterRoomGroups', () => {
  it('keeps everything when nothing is filtered', () => {
    const groups = [group('a'), group('b')];
    expect(filterRoomGroups(groups, NO_FILTERS)).toBe(groups);
  });

  it('keeps only rooms on the chosen messaging apps', () => {
    const groups = [
      group('slack-room', { bridgeType: 'slack' }),
      group('mm-room', { bridgeType: 'mattermost' }),
      group('bare-room', { bridgeType: null }),
    ];

    const kept = filterRoomGroups(groups, {
      bridgeTypes: new Set(['slack']),
      hasLiveSession: false,
    });

    expect(kept.map((g) => g.roomKey)).toEqual(['slack-room']);
  });

  it('can filter for rooms with no messaging app at all', () => {
    const groups = [group('slack-room', { bridgeType: 'slack' }), group('bare-room')];

    const kept = filterRoomGroups(groups, {
      bridgeTypes: new Set([UNBRIDGED_FILTER_VALUE]),
      hasLiveSession: false,
    });

    expect(kept.map((g) => g.roomKey)).toEqual(['bare-room']);
  });

  it('keeps only rooms with something actually running', () => {
    const groups = [
      group('running', { sessions: [{ id: 's1', running: true }] }),
      // A session that exists but has not started is not a room in use.
      group('starting', { sessions: [{ id: 's2', running: false }] }),
      group('idle'),
    ];

    const kept = filterRoomGroups(groups, {
      bridgeTypes: new Set<string>(),
      hasLiveSession: true,
    });

    expect(kept.map((g) => g.roomKey)).toEqual(['running']);
  });

  it('ANDs the dimensions together', () => {
    const groups = [
      group('slack-live', { bridgeType: 'slack', sessions: [{ id: 's1', running: true }] }),
      group('slack-idle', { bridgeType: 'slack' }),
      group('mm-live', { bridgeType: 'mattermost', sessions: [{ id: 's2', running: true }] }),
    ];

    const kept = filterRoomGroups(groups, {
      bridgeTypes: new Set(['slack']),
      hasLiveSession: true,
    });

    expect(kept.map((g) => g.roomKey)).toEqual(['slack-live']);
  });
});

describe('sortRoomGroups', () => {
  it('sorts by name by default', () => {
    const groups = [group('b', { label: 'Beta' }), group('a', { label: 'Alpha' })];
    expect(sortRoomGroups(groups, 'name').map((g) => g.label)).toEqual(['Alpha', 'Beta']);
  });

  it('sorts newest first by creation', () => {
    const groups = [
      group('old', { createdAt: '2026-01-01T00:00:00Z' }),
      group('new', { createdAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(sortRoomGroups(groups, 'created-at').map((g) => g.roomKey)).toEqual(['new', 'old']);
  });

  it('sorts by the most recent session activity in each room', () => {
    const groups = [
      group('quiet', { sessions: [{ id: 's1', usedAt: '2026-01-01T00:00:00Z' }] }),
      group('busy', {
        sessions: [
          { id: 's2', usedAt: '2026-01-02T00:00:00Z' },
          { id: 's3', usedAt: '2026-09-01T00:00:00Z' },
        ],
      }),
    ];
    expect(sortRoomGroups(groups, 'updated-at').map((g) => g.roomKey)).toEqual(['busy', 'quiet']);
  });

  it('puts rooms with no value for the sort key last, then orders them by name', () => {
    // Most rooms have nothing running in them; that has to be an ordinary case
    // rather than one that scatters them through the list.
    const groups = [
      group('never-used-z', { label: 'Zeta' }),
      group('used', { label: 'Used', sessions: [{ id: 's1', usedAt: '2026-01-01T00:00:00Z' }] }),
      group('never-used-a', { label: 'Alpha' }),
    ];
    expect(sortRoomGroups(groups, 'updated-at').map((g) => g.label)).toEqual([
      'Used',
      'Alpha',
      'Zeta',
    ]);
  });

  it('does not reorder the array it was given', () => {
    const groups = [group('b', { label: 'Beta' }), group('a', { label: 'Alpha' })];
    sortRoomGroups(groups, 'name');
    expect(groups.map((g) => g.label)).toEqual(['Beta', 'Alpha']);
  });
});
