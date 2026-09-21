/**
 * The store mirrors a list the main process owns, and the reconcile moves that
 * list without a window having asked. These cover the seam that carries such a
 * change across, which is otherwise only exercised by a running app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>(async () => []));
const getActiveId = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const subscribers = vi.hoisted(() => new Map<string, (data: unknown) => void>());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { workspaces: { list, getActiveId } },
  events: {
    on: (event: { name: string }, cb: (data: unknown) => void) => {
      subscribers.set(event.name, cb);
      return () => subscribers.delete(event.name);
    },
  },
}));

const { WorkspacesStore } = await import('./workspaces-store');
const { workspacesChangedChannel } = await import('@shared/core/workspaces/workspaceEvents');

function workspace(id: string, name: string) {
  return {
    id,
    serverId: 'srv-1',
    name,
    tenantId: `tenant-${id}`,
    slug: name.toLowerCase(),
    role: 'member' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('WorkspacesStore', () => {
  beforeEach(() => {
    subscribers.clear();
    list.mockReset().mockResolvedValue([]);
    getActiveId.mockReset().mockResolvedValue(null);
  });

  it('re-reads the list when the main process says it changed', async () => {
    const store = new WorkspacesStore();
    list.mockResolvedValue([workspace('ws-1', 'Acme')]);
    await store.refresh();

    list.mockResolvedValue([workspace('ws-1', 'Acme'), workspace('ws-2', 'Skunkworks')]);
    subscribers.get(workspacesChangedChannel.name)!(undefined);
    await vi.waitFor(() => expect(store.workspaces).toHaveLength(2));
  });

  /**
   * The reconcile drops the placeholder a server was registered with once every
   * membership has a row of its own. A window still listing it offers a
   * workspace that no longer exists, and the only thing it can report on the
   * click is that the switch failed — not that the row went.
   */
  it('drops a workspace the main process no longer has', async () => {
    const store = new WorkspacesStore();
    list.mockResolvedValue([workspace('ws-1', 'Acme'), workspace('ws-2', 'Skunkworks')]);
    getActiveId.mockResolvedValue('ws-1');
    await store.refresh();

    list.mockResolvedValue([workspace('ws-2', 'Skunkworks')]);
    getActiveId.mockResolvedValue('ws-2');
    subscribers.get(workspacesChangedChannel.name)!(undefined);

    await vi.waitFor(() => expect(store.byId('ws-1')).toBeNull());
    expect(store.activeId).toBe('ws-2');
  });
});
