/**
 * A bridged room's settings page: what someone who may write to the room can
 * change, and what someone who may not is shown instead.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRoomDetail = vi.hoisted(() => vi.fn());
const setRoomAgentJoinEvents = vi.hoisted(() => vi.fn());
const createRoomRole = vi.hoisted(() => vi.fn());
const setRoomArchived = vi.hoisted(() => vi.fn());
const permissions = vi.hoisted(() => ({ value: { canWrite: true, canManage: true } }));

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
      getRoomDetail,
      setRoomAgentJoinEvents,
      createRoomRole,
      setRoomArchived,
      updateRoom: vi.fn(),
      syncRoomName: vi.fn(),
      listAgents: vi.fn(() =>
        Promise.resolve([{ id: 'a-1', name: 'reviewer-bot', iconUrl: null, knownAgentType: null }])
      ),
      listRoomGroups: vi.fn(() => Promise.resolve([])),
    },
    agents: { getAgents: vi.fn(() => Promise.resolve([])) },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws-1',
    roomServerId: () => 'server-1',
    canDeleteRoom: () => permissions.value.canManage,
    roomPermissions: () => permissions.value,
    refreshRoomState: vi.fn(async () => {}),
  },
}));

vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: vi.fn(async () => {}),
  refreshSidebarRoomStateAfterOnboarding: vi.fn(),
}));

import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';

const ROOM = {
  id: 'room-1',
  name: 'design-review',
  description: 'Where we review designs',
  instructions: '',
  channelType: 'channel_public',
  agentCount: 1,
  bridgeType: 'mattermost',
  bridgeDisplayName: 'Mattermost',
  externalChannelUrl: null,
  ownerId: 'u-1',
  viewerIsMember: true,
  isConsoleChat: false,
  createdAt: '2026-10-01T09:00:00+00:00',
  agentIds: ['a-1'],
  connectedUserNames: ['ada'],
  linkedChannelName: null,
  readVisibility: 'public',
  writeVisibility: 'private',
  groupId: null,
  groupName: null,
  ownerName: 'Ada',
  bridgeId: 'bridge-1',
  agentStatuses: { 'a-1': 'live' },
  roles: [],
  joinEventListeners: [],
  externalChannelId: 'C123',
  transportRoomId: '!abc:switch.local',
  archived: false,
  archivedAt: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  getRoomDetail.mockReset();
  getRoomDetail.mockResolvedValue(ROOM);
  setRoomAgentJoinEvents.mockReset();
  setRoomAgentJoinEvents.mockImplementation(
    (params: { receivesJoinEvents: boolean; agentId: string }) =>
      Promise.resolve({
        ...ROOM,
        joinEventListeners: params.receivesJoinEvents ? [params.agentId] : [],
      })
  );
  createRoomRole.mockReset();
  createRoomRole.mockImplementation(
    (params: { role: { name: string; instructions: string; exclusive: boolean } }) =>
      Promise.resolve([{ ...params.role, heldBy: [] }])
  );
  setRoomArchived.mockReset();
  setRoomArchived.mockImplementation((params: { archived: boolean }) =>
    Promise.resolve({ ...ROOM, archived: params.archived })
  );
  permissions.value = { canWrite: true, canManage: true };
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
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
  return container;
}

function button(el: HTMLElement, text: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    text.test(b.textContent?.trim() ?? '')
  );
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('room settings for someone who may write to the room', () => {
  it('shows each agent’s presence, and access as a control for its manager', async () => {
    const el = await renderPanel();
    expect(el.textContent).toContain('reviewer-bot');
    expect(el.textContent).toContain('Here now');
    expect(el.querySelector('[aria-label="Who can see and post"]')).not.toBeNull();
    expect(el.textContent).toContain('C123');
  });

  it('turns an agent’s join notification on', async () => {
    const el = await renderPanel();
    const toggle = el.querySelector<HTMLElement>(
      '[aria-label="Tell reviewer-bot when someone joins"]'
    )!;
    await click(toggle);
    expect(setRoomAgentJoinEvents).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      agentId: 'a-1',
      receivesJoinEvents: true,
    });
  });

  it('adds a role and lists it', async () => {
    const el = await renderPanel();
    await click(button(el, /^Add role$/)!);
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Role name"]')!, 'reviewer');
    await type(
      el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Role instructions"]')!,
      'Review every change'
    );
    const add = [...el.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Add role'
    );
    await click(add.at(-1)!);
    expect(createRoomRole).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      role: { name: 'reviewer', instructions: 'Review every change', exclusive: false },
    });
    expect(el.textContent).toContain('Nobody holds it right now');
  });

  it('archives the room', async () => {
    const el = await renderPanel();
    await click(button(el, /^Archive$/)!);
    expect(setRoomArchived).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      archived: true,
    });
    expect(el.textContent).toContain('This room is archived');
  });
});

describe('room settings for someone who may only read the room', () => {
  it('says who can change it, and offers no changes', async () => {
    permissions.value = { canWrite: false, canManage: false };
    const el = await renderPanel();
    expect(el.textContent).toContain(
      'Only Ada or a workspace admin can change this room’s settings.'
    );
    expect(el.querySelector('[aria-label="Who can see and post"]')).toBeNull();
    expect(button(el, /^Add agent$/)).toBeUndefined();
    expect(button(el, /^Archive$/)).toBeUndefined();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.disabled).toBe(true);
  });
});
