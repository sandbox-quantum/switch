/**
 * A room's auto-route switch on its settings page, beside `!auto-route` and
 * writing the same setting. It shows what the server says: on or off, and,
 * where the workspace has no decision backend, unavailable with the server's
 * own reason. Below it, the room's triage agent for while auto-route is
 * unavailable, picked from the room's own agents.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { RoomAutoRoute } from '@shared/core/switch-servers/switch-servers';

const getRoomDetail = vi.hoisted(() => vi.fn());
const setRoomAutoRoute = vi.hoisted(() => vi.fn());

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
      setRoomAutoRoute,
      updateRoom: vi.fn(),
      listAgents: vi.fn(() =>
        Promise.resolve([
          { id: 'agent-deploy', name: 'deploy-bot', iconUrl: null, knownAgentType: null },
          { id: 'agent-triage', name: 'triage-bot', iconUrl: null, knownAgentType: null },
        ])
      ),
    },
    agents: { getAgents: vi.fn(() => Promise.resolve([])) },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws-1',
    roomServerId: () => 'server-1',
    canDeleteRoom: () => false,
    // As the real store: the server's answer for the room, and nothing
    // without one (these rooms always carry it).
    roomPermissions: (_workspaceId: string, room: { serverPermissions?: unknown }) =>
      room.serverPermissions ?? { canWrite: false, canManage: false, canUnlink: false },
  },
}));

import { chatsStore } from '@renderer/features/chats/stores/chats';
import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';

const NO_BACKEND =
  'Auto-route needs a decision service. A workspace admin can set one up in Switch Console → Admin → Decision routing.';

const OFF: RoomAutoRoute = {
  on: false,
  available: true,
  reason: null,
  fallbackAgent: null,
  fallbackAgentName: null,
};

/** What the server says the signed-in account may do in the room. */
type Access = { canWrite: boolean; canManage: boolean };

const MANAGER: Access = { canWrite: true, canManage: true };

function room(autoRoute: RoomAutoRoute | undefined, access: Access) {
  return {
    id: 'room-1',
    ownerId: 'user-owner',
    serverPermissions: { ...access, canUnlink: access.canWrite },
    name: 'ops',
    description: '',
    instructions: null,
    bridgeType: null,
    bridgeDisplayName: null,
    externalChannelUrl: null,
    agentIds: ['agent-deploy', 'agent-triage'],
    connectedUserNames: [],
    readVisibility: 'public',
    writeVisibility: 'private',
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
    ...(autoRoute ? { autoRoute } : {}),
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.spyOn(workspacesStore, 'serverIdFor').mockReturnValue('server-1');
  getRoomDetail.mockReset();
  setRoomAutoRoute.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(
  autoRoute: RoomAutoRoute | undefined,
  access: Access = MANAGER
): Promise<HTMLElement> {
  getRoomDetail.mockResolvedValue(room(autoRoute, access));
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

function toggle(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Auto-route in this room"]'
  );
  if (!found) throw new Error('no auto-route switch');
  return found;
}

function checked(el: HTMLElement): boolean {
  return toggle(el).getAttribute('aria-checked') === 'true';
}

function disabled(el: HTMLElement): boolean {
  const t = toggle(el);
  return t.hasAttribute('data-disabled') || t.getAttribute('aria-disabled') === 'true';
}

async function pickTriage(el: HTMLElement, choice: string) {
  await act(async () => el.querySelector<HTMLElement>('[aria-label="Triage agent"]')!.click());
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === choice
  );
  if (!option) throw new Error(`no option ${choice}`);
  await act(async () => option.click());
}

it('shows nothing for a server that predates auto-route', async () => {
  const el = await render(undefined);

  expect(el.textContent).toContain('General');
  expect(el.querySelector('[aria-label="Auto-route in this room"]')).toBeNull();
});

it('turns auto-route on, and shows it on once the server says so', async () => {
  setRoomAutoRoute.mockResolvedValue({ ...OFF, on: true });
  const el = await render(OFF);
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());
  expect(checked(el)).toBe(false);

  await act(async () => toggle(el).click());

  expect(setRoomAutoRoute).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    roomId: 'room-1',
    on: true,
  });
  await vi.waitFor(() => expect(checked(el)).toBe(true));
});

it('turns auto-route off', async () => {
  setRoomAutoRoute.mockResolvedValue(OFF);
  const el = await render({ ...OFF, on: true });
  await vi.waitFor(() => expect(checked(el)).toBe(true));

  await act(async () => toggle(el).click());

  expect(setRoomAutoRoute).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    roomId: 'room-1',
    on: false,
  });
  await vi.waitFor(() => expect(checked(el)).toBe(false));
});

it('leaves the switch as it was when the server refuses, with the reason', async () => {
  setRoomAutoRoute.mockRejectedValue(new Error('Not authorized to write this resource'));
  const el = await render(OFF);
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  await act(async () => toggle(el).click());

  await vi.waitFor(() => expect(el.textContent).toContain('Not changed —'));
  expect(el.textContent).toContain('Not authorized to write this resource');
  expect(checked(el)).toBe(false);
});

it('shows auto-route unavailable with the server’s reason, and holds the switch', async () => {
  const el = await render({
    on: false,
    available: false,
    reason: NO_BACKEND,
    fallbackAgent: null,
    fallbackAgentName: null,
  });
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(el.textContent).toContain(`Unavailable: ${NO_BACKEND}`);
  expect(disabled(el)).toBe(true);
});

it('still lets auto-route be turned off where it is on but unavailable', async () => {
  const el = await render({
    on: true,
    available: false,
    reason: NO_BACKEND,
    fallbackAgent: null,
    fallbackAgentName: null,
  });
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(el.textContent).toContain(`On, but unavailable: ${NO_BACKEND}`);
  expect(disabled(el)).toBe(false);
});

it('names the room’s triage agent from its own agents, and clears it', async () => {
  setRoomAutoRoute.mockResolvedValueOnce({
    ...OFF,
    fallbackAgent: 'agent-triage',
    fallbackAgentName: 'triage-bot',
  });
  const el = await render(OFF);
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Triage agent"]')?.textContent).toContain('None')
  );

  await pickTriage(el, 'triage-bot');

  expect(setRoomAutoRoute).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    roomId: 'room-1',
    fallbackAgent: 'agent-triage',
  });
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Triage agent"]')?.textContent).toContain('triage-bot')
  );

  setRoomAutoRoute.mockResolvedValueOnce(OFF);
  await pickTriage(el, 'None');
  expect(setRoomAutoRoute).toHaveBeenLastCalledWith({
    workspaceId: 'ws-1',
    roomId: 'room-1',
    fallbackAgent: null,
  });
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Triage agent"]')?.textContent).toContain('None')
  );
});

it('names a triage agent by the name the server gives, even one that has left the room', async () => {
  const el = await render({ ...OFF, fallbackAgent: 'agent-gone', fallbackAgentName: 'old-triage' });

  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Triage agent"]')?.textContent).toContain('old-triage')
  );
});

function picker(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>('[aria-label="Triage agent"]')!;
}

function pickerHeld(el: HTMLElement): boolean {
  const p = picker(el);
  return p.hasAttribute('data-disabled') || p.hasAttribute('disabled');
}

it('lets someone who may write to the room turn it on, but not name the triage agent', async () => {
  setRoomAutoRoute.mockResolvedValue({ ...OFF, on: true });
  const el = await render(OFF, { canWrite: true, canManage: false });
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(disabled(el)).toBe(false);
  expect(pickerHeld(el)).toBe(true);
  expect(el.textContent).toContain('Only the room’s owner or a workspace admin can change this.');
  expect(el.textContent).not.toContain('needs write access');

  await act(async () => toggle(el).click());

  expect(setRoomAutoRoute).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    roomId: 'room-1',
    on: true,
  });
  await vi.waitFor(() => expect(checked(el)).toBe(true));
});

it('holds the switch and picker for a read-only viewer, with the reason', async () => {
  const el = await render({ ...OFF, on: true }, { canWrite: false, canManage: false });
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(checked(el)).toBe(true);
  expect(disabled(el)).toBe(true);
  expect(pickerHeld(el)).toBe(true);
  expect(el.textContent).toContain('Turning auto-route on or off needs write access to this room.');
  expect(el.textContent).toContain('Only the room’s owner or a workspace admin can change this.');
});

it('offers both to the room’s owner or a workspace admin', async () => {
  const el = await render(OFF, MANAGER);
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(disabled(el)).toBe(false);
  expect(pickerHeld(el)).toBe(false);
  // The access section above says its own "Only the room’s owner and
  // workspace admins" to managers; the triage picker's refusal is absent.
  expect(el.textContent).not.toContain(
    'Only the room’s owner or a workspace admin can change this.'
  );
  expect(el.textContent).not.toContain('needs write access');
});

it('shows a group chat’s auto-route too, which can start on from the workspace default', async () => {
  runInAction(() => {
    chatsStore.serverId = 'server-1';
  });
  chatsStore.upsert({
    roomId: 'room-1',
    name: 'ops',
    channelType: 'channel_private',
    bridgeType: null,
    channelName: null,
    agents: [],
    canManage: true,
    ownsAgent: true,
    memberUserIds: [],
    memberCount: 2,
    unreadCount: 0,
    lastMessage: null,
  } satisfies ChatSummary);
  try {
    setRoomAutoRoute.mockResolvedValue(OFF);
    const el = await render({ ...OFF, on: true });
    await vi.waitFor(() => expect(toggle(el)).toBeTruthy());
    expect(el.textContent).toContain('Leave room');
    expect(checked(el)).toBe(true);

    await act(async () => toggle(el).click());

    expect(setRoomAutoRoute).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roomId: 'room-1',
      on: false,
    });
  } finally {
    runInAction(() => {
      chatsStore.chats.delete('room-1');
      chatsStore.serverId = null;
    });
  }
});
