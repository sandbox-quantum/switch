/**
 * Saving a room's description and instructions (CHOO-2173).
 *
 * They used to be written when a field lost focus, so the moment they were
 * stored was the moment you looked away — and in practice leaving the
 * configuration tab was the only thing that reliably did it, which is a strange
 * way to be told your edit counted. These pin the replacement: nothing is
 * written until Save is pressed, the button says whether there is anything to
 * write, and both fields travel in one request.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateRoom = vi.hoisted(() => vi.fn());
const getRoomDetail = vi.hoisted(() => vi.fn());
const syncRoomName = vi.hoisted(() => vi.fn());
const manages = vi.hoisted(() => ({ value: false }));

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
      updateRoom,
      getRoomDetail,
      syncRoomName,
      listAgents: vi.fn(() => Promise.resolve([])),
      listRoomGroups: vi.fn(() => Promise.resolve([])),
    },
    agents: { getAgents: vi.fn(() => Promise.resolve([])) },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws-1',
    roomServerId: () => 'server-1',
    canDeleteRoom: () => manages.value,
    roomPermissions: () => ({ canWrite: true, canManage: manages.value }),
  },
}));

const refreshSidebarRoomState = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState,
  refreshSidebarRoomStateAfterOnboarding: vi.fn(),
}));

import { chatsStore } from '@renderer/features/chats/stores/chats';
import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';

const ROOM = {
  id: 'room-1',
  name: 'charlie',
  description: 'The original description',
  instructions: 'The original instructions',
  bridgeType: null,
  bridgeDisplayName: null,
  externalChannelUrl: null,
  agentIds: [],
  connectedUserNames: [],
  readVisibility: 'public',
  writeVisibility: 'public',
  groupId: null,
  groupName: null,
  ownerName: 'Ada',
  bridgeId: null,
  agentStatuses: {},
  roles: [],
  joinEventListeners: [],
  externalChannelId: null,
  transportRoomId: null,
  archived: false,
  archivedAt: null,
  createdAt: '2026-10-01T09:00:00+00:00',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  updateRoom.mockReset();
  updateRoom.mockImplementation((params: Record<string, unknown>) =>
    Promise.resolve({ ...ROOM, ...params })
  );
  getRoomDetail.mockReset();
  getRoomDetail.mockResolvedValue(ROOM);
  syncRoomName.mockReset();
  manages.value = false;
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
        <RoomConfigurationPanel roomId="room-1" />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

function saveButton(el: HTMLElement): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /^Save/.test(b.textContent?.trim() ?? '')
  );
  expect(found, 'no Save button').toBeDefined();
  return found!;
}

/** Type into a controlled input/textarea the way React will notice. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function description(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('input[placeholder="What this room is for"]')!;
}

function instructions(el: HTMLElement): HTMLTextAreaElement {
  return el.querySelector<HTMLTextAreaElement>('textarea')!;
}

describe('a room’s description and instructions', () => {
  it('offers nothing to save until something is edited', async () => {
    const el = await renderPanel();

    expect(saveButton(el).disabled).toBe(true);
  });

  it('does not write anything just because a field was left', async () => {
    // The old behaviour, and the whole point of the change.
    const el = await renderPanel();
    const field = description(el);
    await type(field, 'Edited but not saved');
    await act(async () => field.dispatchEvent(new FocusEvent('blur', { bubbles: true })));

    expect(updateRoom).not.toHaveBeenCalled();
  });

  it('says there are unsaved changes rather than leaving it ambiguous', async () => {
    const el = await renderPanel();
    await type(description(el), 'Edited but not saved');

    expect(el.textContent).toContain('Unsaved changes');
    expect(saveButton(el).disabled).toBe(false);
  });

  it('writes both fields in one request when Save is pressed', async () => {
    // One request, so the pair is stored together or not at all — and the
    // untouched field is sent as it stands rather than being left out.
    const el = await renderPanel();
    await type(instructions(el), 'Be brief');

    await act(async () => saveButton(el).click());

    expect(updateRoom).toHaveBeenCalledTimes(1);
    expect(updateRoom).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      description: 'The original description',
      instructions: 'Be brief',
    });
  });

  it('settles back to nothing-to-save once it has written', async () => {
    const el = await renderPanel();
    await type(description(el), 'A new description');

    await act(async () => saveButton(el).click());
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());

    expect(el.textContent).toContain('Saved.');
    expect(saveButton(el).disabled).toBe(true);
  });

  it('says so in the server’s own words when the write is refused', async () => {
    updateRoom.mockRejectedValueOnce(new Error('room is archived'));
    const el = await renderPanel();
    await type(description(el), 'A new description');

    await act(async () => saveButton(el).click());
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());

    expect(el.textContent).toContain('room is archived');
    // Still offered, because the edit is still there and still unwritten.
    expect(saveButton(el).disabled).toBe(false);
  });
  it('renames the room, and reads its name again wherever it shows', async () => {
    const refreshSummaries = vi.spyOn(chatsStore, 'refreshSummaries').mockResolvedValue();
    const el = await renderPanel();
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, ' Ship review ');

    await act(async () => saveButton(el).click());
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());

    expect(updateRoom).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      name: 'Ship review',
      description: 'The original description',
      instructions: 'The original instructions',
    });
    expect(refreshSidebarRoomState).toHaveBeenCalledWith(true);
    expect(refreshSummaries).toHaveBeenCalled();
    expect(el.textContent).toContain('Saved.');
  });

  it('does not save an empty name', async () => {
    const el = await renderPanel();
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, '  ');
    expect(saveButton(el).disabled).toBe(true);
  });
  describe('a bridged room named apart from its channel', () => {
    const BRIDGED = {
      ...ROOM,
      name: 'qa-overnight-adopted',
      bridgeType: 'discord',
      bridgeDisplayName: 'Discord',
      linkedChannelName: 'qa-adopted-renamed',
    };
    const useButton = (el: HTMLElement) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent === 'Use channel name');

    it('offers someone who manages it the channel’s name, and reads the new name everywhere', async () => {
      manages.value = true;
      getRoomDetail.mockResolvedValue(BRIDGED);
      syncRoomName.mockResolvedValue({ ...BRIDGED, name: 'qa-adopted-renamed' });
      const refreshSummaries = vi.spyOn(chatsStore, 'refreshSummaries').mockResolvedValue();
      const el = await renderPanel();
      expect(el.textContent).toContain('Linked channel: #qa-adopted-renamed');

      await act(async () => useButton(el)!.click());
      for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());

      expect(syncRoomName).toHaveBeenCalledWith({ workspaceId: 'ws-1', roomId: 'room-1' });
      expect(el.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value).toBe(
        'qa-adopted-renamed'
      );
      expect(refreshSidebarRoomState).toHaveBeenCalledWith(true);
      expect(refreshSummaries).toHaveBeenCalled();
      expect(el.textContent).not.toContain('Linked channel');
    });

    it('says the server’s refusal where the action is', async () => {
      manages.value = true;
      getRoomDetail.mockResolvedValue(BRIDGED);
      syncRoomName.mockRejectedValue(
        new Error('Switch has not seen the name of a channel linked to this room.')
      );
      const el = await renderPanel();
      await act(async () => useButton(el)!.click());
      for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('has not seen the name');
    });

    it('shows the channel’s name, without the action, to someone who does not manage it', async () => {
      getRoomDetail.mockResolvedValue(BRIDGED);
      const el = await renderPanel();
      expect(el.textContent).toContain('Linked channel: #qa-adopted-renamed');
      expect(useButton(el)).toBeUndefined();
    });

    it('says nothing when the room is already called what its channel is', async () => {
      manages.value = true;
      getRoomDetail.mockResolvedValue({ ...BRIDGED, name: 'qa-adopted-renamed' });
      const el = await renderPanel();
      expect(el.textContent).not.toContain('Linked channel');
    });
  });
});
