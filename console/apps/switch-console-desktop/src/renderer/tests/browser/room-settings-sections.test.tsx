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
const permissions = vi.hoisted(() => ({
  value: { canWrite: true, canChangeMembers: true, canManage: true },
}));
const admin = vi.hoisted(() => ({ value: true }));
const setRoomGroup = vi.hoisted(() => vi.fn());
const listBridgePeople = vi.hoisted(() => vi.fn());

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
      listRoomGroups: vi.fn(() => Promise.resolve([{ id: 'g-1', name: 'Design' }])),
      setRoomGroup,
      listBridgePeople,
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

vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceById: () => admin.value,
  administersWorkspaceInScope: () => admin.value,
  operatesServer: () => false,
}));

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: [] }),
}));

import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';
import { RoomSidePanel } from '@renderer/features/switch-rooms/room-side-panel';

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
  permissions.value = { canWrite: true, canChangeMembers: true, canManage: true };
  admin.value = true;
  listBridgePeople.mockReset();
  listBridgePeople.mockResolvedValue([]);
  setRoomGroup.mockReset();
  setRoomGroup.mockImplementation(() =>
    Promise.resolve({ ...ROOM, groupId: null, groupName: null })
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderPanel(
  panel: 'configuration' | 'side' = 'configuration'
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        {panel === 'side' ? (
          <RoomSidePanel roomId="room-1" />
        ) : (
          <RoomConfigurationPanel roomId="room-1" />
        )}
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
  it('shows access as a control for its manager, and leaves who is in the room to the side', async () => {
    const el = await renderPanel();
    expect(el.querySelector('[aria-label="Who can see and change it"]')).not.toBeNull();
    expect(el.textContent).toContain('C123');
    expect(el.textContent).not.toContain('Notify on join');
  });

  it('lists each agent with its presence in the side column, and adds from there', async () => {
    const el = await renderPanel('side');
    expect(el.textContent).toContain('reviewer-bot');
    expect(el.textContent).toContain('Here now');
    expect(el.querySelector('[aria-label="Add agents"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Add people"]')).not.toBeNull();
  });

  it('names who linked each username in the side column, and shows an unlinked username alone', async () => {
    getRoomDetail.mockResolvedValue({ ...ROOM, connectedUserNames: ['ada', 'bob'] });
    listBridgePeople.mockResolvedValue([
      { username: 'ada', externalUserId: 'U1', linkedUserIds: ['u-1'], linkedName: 'Ada Lovelace' },
      { username: 'bob', externalUserId: 'U2', linkedUserIds: [], linkedName: null },
    ]);
    const el = await renderPanel('side');
    expect(listBridgePeople).toHaveBeenCalledWith({ workspaceId: 'ws-1', bridgeId: 'bridge-1' });
    expect(el.textContent).toContain('ada (Ada Lovelace)');
    expect(el.textContent).toContain('bob');
    expect(el.textContent).not.toContain('bob (');
  });

  it('shows the usernames alone when who linked them cannot be read, and says so', async () => {
    listBridgePeople.mockRejectedValue(new Error('offline'));
    const el = await renderPanel('side');
    expect(el.textContent).toContain('ada');
    expect(el.textContent).not.toContain('ada (');
    expect(el.textContent).toContain('Could not load people’s names');
  });

  it('says nothing about names when every lookup worked', async () => {
    const el = await renderPanel('side');
    expect(el.textContent).not.toContain('Could not load people');
  });

  it('offers no adding or removing in a direct conversation, whose platform fixes who is in it', async () => {
    permissions.value = { canWrite: true, canChangeMembers: false, canManage: true };
    getRoomDetail.mockResolvedValue({ ...ROOM, channelType: 'direct' });
    const el = await renderPanel('side');
    expect(el.textContent).toContain('reviewer-bot');
    expect(el.querySelector('[aria-label="Add agents"]')).toBeNull();
    expect(el.querySelector('[aria-label="Add people"]')).toBeNull();
    await click(el.querySelector<HTMLElement>('[aria-label="reviewer-bot in this room"]')!);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.some((item) => /Remove from room/.test(item.textContent ?? ''))).toBe(false);
  });

  it('shows every role an agent holds, matched on its name on the server', async () => {
    getRoomDetail.mockResolvedValue({
      ...ROOM,
      roles: [
        { name: 'reviewer', instructions: '', exclusive: false, heldBy: ['reviewer-bot'] },
        { name: 'lead', instructions: '', exclusive: true, heldBy: ['reviewer-bot'] },
        { name: 'scribe', instructions: '', exclusive: false, heldBy: ['someone-else'] },
      ],
    });
    const el = await renderPanel('side');
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    const text = el.textContent ?? '';
    expect(text).toContain('reviewer');
    expect(text).toContain('lead');
    expect(text).not.toContain('scribe');
  });

  it('says the room could not be read, rather than that it is empty', async () => {
    getRoomDetail.mockRejectedValue(new Error('Switch gateway returned 500'));
    const el = await renderPanel('side');
    expect(el.textContent).not.toContain('No agents in this room yet.');
    expect(el.textContent).not.toContain('Nobody has been seen here yet.');
    expect(el.querySelector('[aria-label="Add agents"]')).toBeNull();
  });

  it('turns an agent’s join notification on from its menu in the side column', async () => {
    const el = await renderPanel('side');
    await click(el.querySelector<HTMLElement>('[aria-label="reviewer-bot in this room"]')!);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
      (each) => /when someone joins/.test(each.textContent ?? '')
    )!;
    await click(item);
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

  it('archives the room once you confirm', async () => {
    const el = await renderPanel();
    await click(button(el, /^Archive$/)!);
    // Nothing yet: it asks first, since the room leaves everyone's lists.
    expect(setRoomArchived).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('everyone else’s');
    const confirm = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Archive'
    )!;
    await click(confirm);
    expect(setRoomArchived).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      archived: true,
    });
    expect(el.textContent).toContain('This room is archived');
  });
});

describe('putting a room in a group', () => {
  it('offers the group picker to a workspace admin', async () => {
    const el = await renderPanel();
    expect(el.querySelector('[aria-label="Group"]')).not.toBeNull();
  });

  it('shows anyone else who may change the room its group, and lets them take it out', async () => {
    admin.value = false;
    permissions.value = { canWrite: true, canChangeMembers: true, canManage: false };
    getRoomDetail.mockResolvedValue({ ...ROOM, groupId: 'g-1', groupName: 'Design' });
    const el = await renderPanel();
    expect(el.querySelector('[aria-label="Group"]')).toBeNull();
    expect(el.textContent).toContain('Design');
    expect(el.textContent).toContain('A workspace admin puts rooms in groups');
    await click(button(el, /^Remove from group$/)!);
    expect(setRoomGroup).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      groupId: null,
    });
  });

  it('names a group the server does not, without offering to change it', async () => {
    admin.value = false;
    getRoomDetail.mockResolvedValue({ ...ROOM, groupId: 'g-9', groupName: null });
    const el = await renderPanel();
    expect(el.textContent).toContain('A group not in your list');
  });
});

describe('room settings for someone who may only read the room', () => {
  it('says who can change it, and offers no changes', async () => {
    permissions.value = { canWrite: false, canChangeMembers: false, canManage: false };
    const el = await renderPanel();
    expect(el.textContent).toContain(
      'Only Ada or a workspace admin can change this room’s settings.'
    );
    expect(el.querySelector('[aria-label="Who can see and change it"]')).toBeNull();
    expect(button(el, /^Add agent$/)).toBeUndefined();
    expect(button(el, /^Archive$/)).toBeUndefined();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.disabled).toBe(true);
  });

  it('lists who is in the room without adding or menus', async () => {
    permissions.value = { canWrite: false, canChangeMembers: false, canManage: false };
    const el = await renderPanel('side');
    expect(el.textContent).toContain('reviewer-bot');
    expect(el.querySelector('[aria-label="Add agents"]')).toBeNull();
    expect(el.querySelector('[aria-label="reviewer-bot in this room"]')).toBeNull();
  });
});
