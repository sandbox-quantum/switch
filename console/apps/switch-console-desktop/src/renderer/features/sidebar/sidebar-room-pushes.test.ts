import { describe, expect, it, vi } from 'vitest';
import type { UserChangesEvent } from '@shared/events/userChangesEvents';
import {
  POLLED_FOCUS_GAP_MS,
  PUSHED_FOCUS_GAP_MS,
  PUSHED_RECONCILE_MS,
  ROOM_NOTICE_BATCH_MS,
  SidebarRoomPushes,
} from './sidebar-room-pushes';

function setup(kinds: Record<string, string[] | null> = {}) {
  const clock = { now: 1_000_000 };
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deps = {
    refreshAll: vi.fn(async () => {}),
    refreshRooms: vi.fn(async (_workspaceId: string, _roomIds: string[]) => {}),
    watch: vi.fn(async () => true),
    unwatch: vi.fn(async () => {}),
    liveKinds: vi.fn(async (_serverId: string, workspaceId: string) => kinds[workspaceId] ?? null),
    now: () => clock.now,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      timers[(timer as unknown as number) - 1].cleared = true;
    },
  };
  const pushes = new SidebarRoomPushes(deps);
  /** Run the batch timer, as its delay passing would. */
  const flush = async () => {
    const due = timers.filter((t) => !t.cleared);
    timers.length = 0;
    for (const timer of due) timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { pushes, deps, clock, timers, flush };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function changed(workspaceId: string, changes: { kind: string; id: string | null }[]) {
  return { serverId: 'srv', workspaceId, type: 'changed', changes } satisfies UserChangesEvent;
}

describe('SidebarRoomPushes', () => {
  it('reads only the rooms a notice names, gathered over a short window', async () => {
    const { pushes, deps, timers, flush } = setup({ 'ws-a': ['room'] });
    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    await settle();

    pushes.onEvent(changed('ws-a', [{ kind: 'room', id: 'r1' }]));
    pushes.onEvent(
      changed('ws-a', [
        { kind: 'room', id: 'r2' },
        { kind: 'room', id: 'r1' },
      ])
    );
    expect(timers.map((t) => t.ms)).toEqual([ROOM_NOTICE_BATCH_MS]);
    await flush();

    expect(deps.refreshRooms).toHaveBeenCalledExactlyOnceWith('ws-a', ['r1', 'r2']);
    expect(deps.refreshAll).not.toHaveBeenCalled();
  });

  it('ignores other kinds, and workspaces it does not follow', async () => {
    const { pushes, deps, timers } = setup({ 'ws-a': ['room'] });
    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    await settle();

    pushes.onEvent(changed('ws-a', [{ kind: 'machine', id: 'm1' }]));
    pushes.onEvent(changed('ws-b', [{ kind: 'room', id: 'r1' }]));
    pushes.onEvent({ ...changed('ws-a', [{ kind: 'room', id: 'r1' }]), serverId: 'other' });

    expect(timers).toEqual([]);
    expect(deps.refreshRooms).not.toHaveBeenCalled();
  });

  it('reads everything for a notice about every room, or a socket that opens', async () => {
    const { pushes, deps, flush } = setup();
    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    await settle();

    pushes.onEvent(changed('ws-a', [{ kind: 'room', id: 'r1' }]));
    pushes.onEvent(changed('ws-a', [{ kind: 'room', id: null }]));
    await flush();
    expect(deps.refreshAll).toHaveBeenCalledOnce();
    expect(deps.refreshRooms).not.toHaveBeenCalled();

    // Whatever changed while it was closed was never told.
    pushes.onEvent({ serverId: 'srv', workspaceId: 'ws-a', type: 'live', kinds: ['room'] });
    await flush();
    expect(deps.refreshAll).toHaveBeenCalledTimes(2);
  });

  it('polls as before until every workspace on screen pushes rooms', async () => {
    const { pushes, clock } = setup({ 'ws-a': ['room'], 'ws-b': ['managed_agent'] });
    pushes.follow([
      { workspaceId: 'ws-a', serverId: 'srv' },
      { workspaceId: 'ws-b', serverId: 'srv' },
    ]);
    await settle();
    await pushes.readWhole();

    // ws-b's server pushes no room changes: every tick reads everything.
    expect(pushes.allPushing()).toBe(false);
    expect(pushes.reconcileDue()).toBe(true);

    pushes.onEvent({ serverId: 'srv', workspaceId: 'ws-b', type: 'live', kinds: ['room'] });
    expect(pushes.allPushing()).toBe(true);
    await pushes.readWhole();
    clock.now += PUSHED_RECONCILE_MS - 1;
    expect(pushes.reconcileDue()).toBe(false);
    clock.now += 1;
    expect(pushes.reconcileDue()).toBe(true);

    // A socket that goes down puts that workspace back on the timer.
    pushes.onEvent({ serverId: 'srv', workspaceId: 'ws-a', type: 'down' });
    await pushes.readWhole();
    expect(pushes.reconcileDue()).toBe(true);
  });

  it('reads on focus at most once a minute while pushed, and every few seconds otherwise', async () => {
    const { pushes, clock } = setup({ 'ws-a': ['room'] });
    expect(pushes.focusDue()).toBe(true);
    await pushes.readWhole();
    clock.now += POLLED_FOCUS_GAP_MS;
    expect(pushes.focusDue()).toBe(true);

    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    await settle();
    await pushes.readWhole();
    clock.now += PUSHED_FOCUS_GAP_MS - 1;
    expect(pushes.focusDue()).toBe(false);
    clock.now += 1;
    expect(pushes.focusDue()).toBe(true);
  });

  it('watches a workspace once, and lets go of one that leaves the screen', async () => {
    const { pushes, deps } = setup({ 'ws-a': ['room'] });
    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    await settle();
    expect(deps.watch).toHaveBeenCalledExactlyOnceWith('srv', 'ws-a');

    pushes.follow([]);
    expect(deps.unwatch).toHaveBeenCalledExactlyOnceWith('srv', 'ws-a');
    expect(pushes.allPushing()).toBe(false);
  });

  it('does not take a workspace that left the screen for pushed when its kinds arrive late', async () => {
    const { pushes } = setup({ 'ws-a': ['room'] });
    pushes.follow([{ workspaceId: 'ws-a', serverId: 'srv' }]);
    pushes.follow([{ workspaceId: 'ws-b', serverId: 'srv' }]);
    await settle();
    expect(pushes.allPushing()).toBe(false);
  });
});
