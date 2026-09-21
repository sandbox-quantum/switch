import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@shared/core/workspaces/workspaces';

const list = vi.hoisted(() => vi.fn());
const getActiveId = vi.hoisted(() => vi.fn());
const setActive = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { workspaces: { list, getActiveId, setActive } },
}));

const { WorkspacesStore } = await import('./workspaces-store');

function workspace(id: string, serverId: string, name = id): Workspace {
  return {
    id,
    serverId,
    name,
    tenantId: `tenant-${id}`,
    slug: id,
    role: 'member',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/** A store holding the given workspaces, scoped to one of them. */
async function loaded(workspaces: Workspace[], activeId: string | null) {
  list.mockResolvedValue(workspaces);
  getActiveId.mockResolvedValue(activeId);
  const store = new WorkspacesStore();
  await store.refresh();
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  setActive.mockResolvedValue(undefined);
});

describe('what the window is scoped to', () => {
  it('reads the server off the workspace rather than holding its own', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-2')], 'ws-b');

    expect(store.active?.id).toBe('ws-b');
    expect(store.activeServerId).toBe('srv-2');
  });

  // Every install has this moment: the list arrives before anything has chosen.
  it('is scoped to nothing while no workspace is selected', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1')], null);

    expect(store.active).toBeNull();
    expect(store.activeServerId).toBeNull();
  });

  /**
   * Removing a server takes its workspaces with it, leaving the stored
   * selection naming one that is gone. Reading that as a selection would scope
   * the window to a server that is no longer there.
   */
  it('is scoped to nothing when the selection names a workspace that has gone', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1')], 'ws-removed');

    expect(store.active).toBeNull();
    expect(store.activeServerId).toBeNull();
  });

  it('moves the scope when a workspace is chosen', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1')], 'ws-a');

    await store.setActive('ws-b');

    expect(setActive).toHaveBeenCalledWith('ws-b');
    expect(store.activeId).toBe('ws-b');
  });

  /**
   * A switch that failed quietly would leave the sidebar listing one
   * workspace's rooms under another one's name — indistinguishable from the
   * rooms having disappeared.
   */
  it('raises and stays put when the selection cannot be saved', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1')], 'ws-a');
    setActive.mockRejectedValue(new Error('database is locked'));

    await expect(store.setActive('ws-b')).rejects.toThrow('database is locked');
    expect(store.activeId).toBe('ws-a');
  });
});

describe('the workspace a server-routed view acts in', () => {
  it('is the active one when the window is scoped to that server', async () => {
    const store = await loaded(
      [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-1'), workspace('ws-c', 'srv-2')],
      'ws-b'
    );

    expect(store.onServerInScope('srv-1')?.id).toBe('ws-b');
  });

  // A server with one workspace has nothing to choose between, so a page for it
  // works whether or not the window is scoped there.
  it('falls back to the only workspace on another server', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1'), workspace('ws-c', 'srv-2')], 'ws-a');

    expect(store.onServerInScope('srv-2')?.id).toBe('ws-c');
  });

  // Addressing the wrong one answers with somebody else's rooms while looking
  // entirely correct, so the view has to render the absence instead.
  it('answers nothing for another server with several workspaces', async () => {
    const store = await loaded(
      [workspace('ws-a', 'srv-1'), workspace('ws-b', 'srv-2'), workspace('ws-c', 'srv-2')],
      'ws-a'
    );

    expect(store.onServerInScope('srv-2')).toBeNull();
    expect(store.idOnServerInScope('srv-2')).toBeNull();
  });

  it('answers nothing for a server whose registration left it with none', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1')], 'ws-a');

    expect(store.idOnServerInScope('srv-2')).toBeNull();
  });

  // Every page routed by server reads this before its server is known.
  it('answers nothing before a server has been chosen', async () => {
    const store = await loaded([workspace('ws-a', 'srv-1')], 'ws-a');

    expect(store.idOnServerInScope(null)).toBeNull();
  });
});
