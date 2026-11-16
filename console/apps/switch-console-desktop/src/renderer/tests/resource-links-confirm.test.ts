// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHISH = 'https://sw1tch-sso.example/login?next=%2Fverify';

const rpcMock = vi.hoisted(() => ({
  getRoomDetail: vi.fn(async () => ({ id: 'room-1', ownerId: 'u-2' })),
  listRoomResources: vi.fn(),
  listLinkedRooms: vi.fn(async () => []),
  getLibraryItem: vi.fn(),
  listLibraryItemRooms: vi.fn(async () => []),
  listReferenceTypes: vi.fn(async () => []),
  listLibrary: vi.fn(async () => []),
  listPackageMembers: vi.fn(async () => []),
}));
const showModal = vi.hoisted(() => vi.fn());
const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces: rpcMock },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal,
  useShowModal: (id: string) => (args: unknown) => showModal(id, args),
}));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'srv', kind: 'references', itemId: 'ref-1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
vi.mock('@renderer/features/switch-rooms/open-room', () => ({ openRoom: async () => {} }));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws',
    roomPermissions: () => ({
      canWrite: false,
      canAttach: false,
      canManage: false,
      canUnlink: false,
    }),
    readableRoomsInWorkspace: () => [],
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws', serverIdFor: () => 'srv', activeId: 'ws' },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [{ id: 'srv', name: 'Server', managed: false }],
    statusFor: () => ({ connected: true, user: { id: 'me' } }),
  },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceById: () => false,
  administersWorkspaceInScope: () => false,
}));
vi.mock('@renderer/features/switch-servers/use-listed-rooms', () => ({
  useReadableRoomsInWorkspace: () => [],
}));

const { RoomResourcesPanel } = await import('@renderer/features/switch-rooms/room-resources-panel');
const { libraryItemView } = await import('@renderer/features/library/library-item-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REFERENCE = {
  id: 'ref-1',
  kind: 'references',
  name: 'IT: verify your password before Monday',
  description: '',
  instructions: '',
  ownerId: 'u-2',
  ownerName: 'Someone',
  readVisibility: 'public',
  writeVisibility: 'private',
  type: 'web',
  typeLabel: null,
  urls: [PHISH],
  attachedRoomsCount: 1,
  packageIds: [],
  referencesCount: 0,
  documentsCount: 0,
  createdByAgentName: null,
  roomScoped: false,
  createdAt: '2026-11-01',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  showModal.mockReset();
  openExternalUrl.mockClear();
  rpcMock.listRoomResources.mockImplementation(async ({ kind }: { kind: string }) =>
    kind === 'references' ? [REFERENCE] : []
  );
  rpcMock.getLibraryItem.mockResolvedValue(REFERENCE);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(Panel: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Panel)))
  );
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

async function clickable(text: string): Promise<HTMLButtonElement> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(text)
    );
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`Nothing to click with "${text}" in: ${container.textContent}`);
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

async function expectConfirmationFirst() {
  expect(openExternalUrl).not.toHaveBeenCalled();
  expect(showModal).toHaveBeenCalledTimes(1);
  const [id, args] = showModal.mock.calls[0] as [string, { url: string; onSuccess: () => void }];
  expect(id).toBe('confirmExternalLinkModal');
  expect(args.url).toBe(PHISH);
  await act(async () => args.onSuccess());
  expect(openExternalUrl).toHaveBeenCalledWith(PHISH, 'Could not open the link');
}

describe('a reference attached to a room', () => {
  it('shows where it goes under its name', async () => {
    await render(() => createElement(RoomResourcesPanel, { roomId: 'room-1' }));
    expect((await clickable(REFERENCE.name)).textContent).toContain('sw1tch-sso.example');
  });

  it('opens only after the confirmation that shows its whole address', async () => {
    await render(() => createElement(RoomResourcesPanel, { roomId: 'room-1' }));
    const row = await clickable(REFERENCE.name);
    await act(async () => row.click());
    await expectConfirmationFirst();
  });
});

describe('a link on a reference’s own page', () => {
  it('opens only after the confirmation that shows its whole address', async () => {
    await render(libraryItemView.MainPanel);
    const link = await clickable(PHISH);
    await act(async () => link.click());
    await expectConfirmationFirst();
  });
});
