/**
 * A room's auto-route switch on its settings page, beside `!auto-route` and
 * writing the same setting. It shows what the server says: on or off, and,
 * where the workspace has no decision backend, unavailable with the server's
 * own reason. Below it, the room's triage agent for while auto-route is
 * unavailable, picked from the room's own agents.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const access = vi.hoisted(() => ({ administers: true }));

vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => access.administers,
  operatesServer: () => false,
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    roomWorkspaceId: () => 'ws-1',
    roomServerId: () => 'server-1',
    canDeleteRoom: () => false,
  },
}));

import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
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

function room(autoRoute: RoomAutoRoute | undefined, ownerId: string | null = null) {
  return {
    id: 'room-1',
    ownerId,
    name: 'ops',
    description: '',
    instructions: null,
    bridgeType: null,
    bridgeDisplayName: null,
    externalChannelUrl: null,
    agentIds: ['agent-deploy', 'agent-triage'],
    connectedUserNames: [],
    ...(autoRoute ? { autoRoute } : {}),
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  access.administers = true;
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
  ownerId: string | null = null
): Promise<HTMLElement> {
  getRoomDetail.mockResolvedValue(room(autoRoute, ownerId));
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
  setRoomAutoRoute.mockRejectedValue(new Error('Only a room admin can change auto-route.'));
  const el = await render(OFF);
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  await act(async () => toggle(el).click());

  await vi.waitFor(() => expect(el.textContent).toContain('Not changed —'));
  expect(el.textContent).toContain('Only a room admin can change auto-route.');
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

it('holds the switch and picker for someone who neither owns the room nor administers the workspace', async () => {
  access.administers = false;
  const el = await render({ ...OFF, on: true });
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(checked(el)).toBe(true);
  expect(disabled(el)).toBe(true);
  const picker = el.querySelector<HTMLElement>('[aria-label="Triage agent"]')!;
  expect(picker.hasAttribute('data-disabled') || picker.hasAttribute('disabled')).toBe(true);
  expect(el.textContent).toContain('Only the room’s owner or a workspace admin can change these.');
});

it('lets the room’s owner change it without administering the workspace', async () => {
  access.administers = false;
  vi.spyOn(switchServersStore, 'statusFor').mockReturnValue({
    user: { id: 'user-owner' },
  } as never);
  const el = await render(OFF, 'user-owner');
  await vi.waitFor(() => expect(toggle(el)).toBeTruthy());

  expect(disabled(el)).toBe(false);
});
