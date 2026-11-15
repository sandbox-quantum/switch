/**
 * A room's Resources tab: what is attached, the documents its agents wrote,
 * the rooms it points at, and the changes offered only to someone the server
 * says may change the room.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listRoomResources = vi.hoisted(() => vi.fn());
const setRoomResourceAttached = vi.hoisted(() => vi.fn());
const listLinkedRooms = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const permissions = vi.hoisted(() => ({
  value: { canWrite: true, canAttach: true, canManage: false, canUnlink: true },
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    workspaces: {
      getRoomDetail: vi.fn(async () => ({ id: 'room-1', ownerId: 'u-2' })),
      listRoomResources,
      setRoomResourceAttached,
      listLinkedRooms,
      listLibrary: vi.fn(async () => []),
    },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws-1',
    roomPermissions: () => permissions.value,
    readableRoomsInWorkspace: () => [],
  },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate }),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { serverIdFor: () => 'srv-1', activeId: 'ws-1' },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { statusFor: () => ({ user: { id: 'me' } }) },
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceById: () => false,
}));

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

import { RoomResourcesPanel } from '@renderer/features/switch-rooms/room-resources-panel';

const base = {
  ownerId: 'u-2',
  readVisibility: 'public',
  description: '',
  typeLabel: null,
  urls: [],
  createdByAgentName: null,
  packageIds: [],
};
const RESOURCES = {
  references: [
    {
      ...base,
      id: 'ref-1',
      kind: 'references',
      name: 'Repo',
      typeLabel: 'GitHub',
      urls: ['https://github.com/acme/repo'],
      roomScoped: false,
      packageIds: ['pkg-1'],
    },
  ],
  documents: [
    { ...base, id: 'd-1', kind: 'documents', name: 'Guide', roomScoped: false },
    {
      ...base,
      id: 'd-2',
      kind: 'documents',
      name: 'Standup notes',
      roomScoped: true,
      createdByAgentName: 'scribe',
    },
  ],
  packages: [{ ...base, id: 'pkg-1', kind: 'packages', name: 'Onboarding', roomScoped: false }],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  listRoomResources.mockReset();
  listRoomResources.mockImplementation(
    async ({ kind }: { kind: keyof typeof RESOURCES }) => RESOURCES[kind]
  );
  setRoomResourceAttached.mockReset();
  setRoomResourceAttached.mockResolvedValue(undefined);
  listLinkedRooms.mockReset();
  listLinkedRooms.mockResolvedValue([
    { roomId: 'room-2', name: 'support', description: '', label: 'escalate to' },
  ]);
  permissions.value = { canWrite: true, canAttach: true, canManage: false, canUnlink: true };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderPanel(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RoomResourcesPanel roomId="room-1" />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
  return container;
}

describe('the Resources tab', () => {
  it('lists what is attached, which package brought it, and the rooms it points at', async () => {
    const el = await renderPanel();
    const text = el.textContent ?? '';
    expect(text).toContain('Repo');
    expect(text).toContain('GitHub');
    expect(text).toContain('via Onboarding');
    expect(text).toContain('Guide');
    expect(text).toContain('Written by agents in this room');
    expect(text).toContain('by scribe');
    expect(text).toContain('support');
    expect(text).toContain('escalate to');
  });

  it('names only a package attached to this room as what brought an item in', async () => {
    listRoomResources.mockImplementation(async ({ kind }: { kind: keyof typeof RESOURCES }) =>
      kind === 'references'
        ? [{ ...RESOURCES.references[0], packageIds: ['pkg-elsewhere'] }]
        : RESOURCES[kind]
    );
    const el = await renderPanel();
    expect(el.textContent).toContain('Repo');
    expect(el.textContent).not.toContain('via');
  });

  it('opens a document from what the room listed, without fetching it again', async () => {
    listRoomResources.mockImplementation(async ({ kind }: { kind: keyof typeof RESOURCES }) =>
      kind === 'documents'
        ? [{ ...RESOURCES.documents[0], content: 'Read **this** first.' }]
        : RESOURCES[kind]
    );
    const el = await renderPanel();
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Guide'))!;
    await act(async () => open.click());
    for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
    // Rendered as markdown, from what the listing carried.
    expect(document.querySelector('[data-slot="dialog-content"] strong')?.textContent).toBe('this');
  });

  it('offers attaching, detaching, deleting and linking to someone who may change the room', async () => {
    const el = await renderPanel();
    expect(el.textContent).toContain('Attach reference');
    expect(el.textContent).toContain('Link a room');
    expect(el.querySelector('[aria-label="Delete Standup notes"]')).not.toBeNull();
    await act(async () =>
      el.querySelector<HTMLButtonElement>('[aria-label="Detach Guide"]')!.click()
    );
    expect(setRoomResourceAttached).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      kind: 'documents',
      resourceId: 'd-1',
      attached: false,
    });
  });

  it('asks before deleting a document an agent wrote, since it goes for everyone', async () => {
    const el = await renderPanel();
    await act(async () =>
      el.querySelector<HTMLButtonElement>('[aria-label="Delete Standup notes"]')!.click()
    );
    expect(setRoomResourceAttached).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Delete for everyone?');
    const confirm = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!;
    await act(async () => confirm.click());
    expect(setRoomResourceAttached).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'd-2', attached: false })
    );
  });

  it('lets someone attach without detaching, as the server keeps detaching for those taking part', async () => {
    permissions.value = { canWrite: true, canAttach: true, canManage: false, canUnlink: false };
    const el = await renderPanel();
    expect(el.textContent).toContain('Attach reference');
    expect(el.querySelector('[aria-label^="Detach"]')).toBeNull();
  });

  it('follows the server on who may delete each document', async () => {
    listRoomResources.mockImplementation(async ({ kind }: { kind: keyof typeof RESOURCES }) =>
      kind === 'documents'
        ? RESOURCES.documents.map((doc) => ({ ...doc, canRemove: false }))
        : RESOURCES[kind]
    );
    const el = await renderPanel();
    expect(el.querySelector('[aria-label="Delete Standup notes"]')).toBeNull();
    expect(el.querySelector('[aria-label="Detach Guide"]')).not.toBeNull();
  });

  it('only lists for someone who may not change the room', async () => {
    permissions.value = { canWrite: false, canAttach: false, canManage: false, canUnlink: false };
    const el = await renderPanel();
    expect(el.textContent).toContain('Repo');
    expect(el.textContent).not.toContain('Attach reference');
    expect(el.textContent).not.toContain('Link a room');
    expect(el.querySelector('[aria-label^="Detach"]')).toBeNull();
    expect(el.querySelector('[aria-label^="Delete"]')).toBeNull();
  });

  it('opens a document from Resources on its page there from the reader, not one written in the room', async () => {
    const el = await renderPanel();
    expect(el.querySelector('[aria-label$=" in Resources"]')).toBeNull();
    const open = (name: string) =>
      act(async () =>
        [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!.click()
      );
    await open('Guide');
    for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
    const goTo = [...document.querySelectorAll('[data-slot="dialog-content"] button')].find(
      (b) => b.textContent === 'Open in Resources'
    ) as HTMLButtonElement;
    await act(async () => goTo.click());
    expect(navigate).toHaveBeenCalledWith('libraryItem', {
      serverId: 'srv-1',
      kind: 'documents',
      itemId: 'd-1',
    });
  });

  it('offers no Resources page for a document its owner keeps private', async () => {
    listRoomResources.mockImplementation(async ({ kind }: { kind: keyof typeof RESOURCES }) =>
      kind === 'documents'
        ? [{ ...RESOURCES.documents[0], readVisibility: 'private', content: 'Secret plans' }]
        : RESOURCES[kind]
    );
    const el = await renderPanel();
    await act(async () =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Guide'))!.click()
    );
    for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    expect(dialog.textContent).toContain('Secret plans');
    expect(
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Open in Resources')
    ).toBeUndefined();
  });

  it('opens a package on its page in Resources when clicked', async () => {
    const el = await renderPanel();
    await act(async () =>
      [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Packages"] button')]
        .find((b) => b.textContent?.includes('Onboarding'))!
        .click()
    );
    expect(navigate).toHaveBeenCalledWith('libraryItem', {
      serverId: 'srv-1',
      kind: 'packages',
      itemId: 'pkg-1',
    });
  });

  it('opens nothing for a reference with no link, rather than taking it for a package', async () => {
    listRoomResources.mockImplementation(async ({ kind }: { kind: keyof typeof RESOURCES }) =>
      kind === 'references' ? [{ ...RESOURCES.references[0], urls: [] }] : RESOURCES[kind]
    );
    const el = await renderPanel();
    const row = [...el.querySelectorAll('[aria-label="References"] button')].find((b) =>
      b.textContent?.includes('Repo')
    );
    expect(row).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens no page for a package its owner keeps private', async () => {
    listRoomResources.mockImplementation(async ({ kind }: { kind: keyof typeof RESOURCES }) =>
      kind === 'packages' ? [{ ...RESOURCES.packages[0], canRead: false }] : RESOURCES[kind]
    );
    const el = await renderPanel();
    const row = [...el.querySelectorAll('[aria-label="Packages"] button')].find((b) =>
      b.textContent?.includes('Onboarding')
    );
    expect(row).toBeUndefined();
    expect(el.querySelector('[aria-label="Packages"]')?.textContent).toContain('Onboarding');
  });
});
