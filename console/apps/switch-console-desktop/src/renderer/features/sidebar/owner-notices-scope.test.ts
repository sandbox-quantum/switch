import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  workspaceId: 'workspace-a' as string | null,
  tenantId: 'tenant-a' as string | null,
  userId: 'owner-a' as string | null,
  connected: true,
}));
const list = vi.hoisted(() => vi.fn(async () => ({ supported: true, notices: [] })));
const useQuery = vi.hoisted(() => vi.fn());
vi.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }));
vi.mock('@tanstack/react-query', () => ({
  useQuery,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isError: false, isPending: false, mutate: vi.fn() }),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    get activeId() {
      return state.workspaceId;
    },
    get active() {
      return { tenantId: state.tenantId };
    },
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    activeServer: { id: 'server-a' },
    statusFor: () => ({
      connected: state.connected,
      user: state.userId ? { id: state.userId } : null,
    }),
  },
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { workspaces: { listOwnerNotices: list } } }));

const { OwnerNotices } = await import('./owner-notices');

beforeEach(() => {
  state.workspaceId = 'workspace-a';
  state.tenantId = 'tenant-a';
  state.userId = 'owner-a';
  state.connected = true;
  list.mockClear();
  useQuery.mockReset().mockReturnValue({ data: { supported: true, notices: [] } });
});

it('does not fetch or display another owner’s notices without a signed-in user', () => {
  state.connected = false;
  expect(renderToStaticMarkup(createElement(OwnerNotices))).toBe('');
  expect(useQuery).not.toHaveBeenCalled();
});

it('binds each request and cache key to the current workspace, tenant, and user', async () => {
  renderToStaticMarkup(createElement(OwnerNotices));
  const first = useQuery.mock.calls[0]![0];
  expect(first.queryKey).toEqual(['owner-notices', 'workspace-a', 'owner-a', 'tenant-a']);
  await first.queryFn();
  expect(list).toHaveBeenCalledWith({
    workspaceId: 'workspace-a',
    userId: 'owner-a',
    tenantId: 'tenant-a',
  });
  state.userId = 'owner-b';
  state.tenantId = 'tenant-b';
  renderToStaticMarkup(createElement(OwnerNotices));
  expect(useQuery.mock.calls[1]![0].queryKey).toEqual([
    'owner-notices',
    'workspace-a',
    'owner-b',
    'tenant-b',
  ]);
});

it('waits for the selected tenant instead of fetching under an unknown scope', () => {
  state.tenantId = null;
  expect(renderToStaticMarkup(createElement(OwnerNotices))).toContain(
    'Connecting to the workspace'
  );
  expect(useQuery).not.toHaveBeenCalled();
});
