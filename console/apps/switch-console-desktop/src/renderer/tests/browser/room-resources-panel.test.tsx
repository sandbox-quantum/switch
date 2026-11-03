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
const permissions = vi.hoisted(() => ({ value: { canWrite: true, canManage: false } }));

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

import { RoomResourcesPanel } from '@renderer/features/switch-rooms/room-resources-panel';

const base = {
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
  permissions.value = { canWrite: true, canManage: false };
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

  it('only lists for someone who may not change the room', async () => {
    permissions.value = { canWrite: false, canManage: false };
    const el = await renderPanel();
    expect(el.textContent).toContain('Repo');
    expect(el.textContent).not.toContain('Attach reference');
    expect(el.textContent).not.toContain('Link a room');
    expect(el.querySelector('[aria-label^="Detach"]')).toBeNull();
    expect(el.querySelector('[aria-label^="Delete"]')).toBeNull();
  });
});
