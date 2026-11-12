/**
 * Settings' "Workspace settings" link opens the web gateway, including the one
 * a Switch this Console runs without Docker serves. A server an older Console
 * started without the gateway's pages is offered the restart that turns them
 * on; one that cannot serve them shows no link. Both links open the settings
 * of whichever layout the server's gateway has on.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const state = vi.hoisted(() => ({
  adminPages: null as 'served' | 'restart' | 'unavailable' | null,
  native: true,
  newLayout: false,
  orgAdmin: false,
  openPage: vi.fn(),
  start: vi.fn(),
  confirms: [] as { title: string; confirmLabel?: string; onSuccess: () => void }[],
}));

const LOCAL = vi.hoisted(() => ({
  id: 'local',
  name: 'Local server',
  url: 'http://localhost:41001',
  dashboardUrl: null,
  managed: true,
  managementKind: 'local' as const,
  sshHost: null,
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    activeServer: LOCAL,
    servers: [LOCAL],
    statusFor: () => ({ connected: true, user: { id: 'u', name: 'admin' } }),
  },
}));
vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: {
    get adminPages() {
      return state.adminPages;
    },
    lacksAdminPages: (server: { managed: boolean; managementKind: string }) =>
      server.managed &&
      server.managementKind === 'local' &&
      state.native &&
      state.adminPages !== 'served',
  },
}));
vi.mock('@renderer/features/switch-servers/managed-server-actions', () => ({
  startManagedServer: (...args: unknown[]) => state.start(...args),
}));
vi.mock('@renderer/features/switch-servers/open-server-page', () => ({
  openServerPage: (...args: unknown[]) => state.openPage(...args),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => (args: (typeof state.confirms)[number]) => state.confirms.push(args),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    onServerInScope: () => ({
      id: 'w',
      serverId: 'local',
      tenantId: 't',
      role: 'member',
      organizationRole: state.orgAdmin ? 'org_admin' : null,
    }),
  },
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useAnyServerFeatureFlag: () => false,
  useFeatureFlags: () => ({ gateway_v2: state.newLayout }),
}));
vi.mock('@renderer/features/settings/pages/account-page', () => ({
  AccountSettingsPage: () => null,
}));
vi.mock('@renderer/features/agent-migration/migration-settings-page', () => ({
  MigrationSettingsPage: () => null,
}));
vi.mock('@renderer/features/machines/devices-settings-page', () => ({
  DevicesSettingsPage: () => null,
}));
vi.mock('@renderer/features/remote-hosts/views/remote-hosts-view', () => ({
  RemoteHostsSettingsPage: () => null,
}));
vi.mock('@renderer/features/settings/agents-page/AgentsSettingsPage', () => ({
  AgentsSettingsPage: () => null,
}));
vi.mock('@renderer/features/settings/pages/api-keys-page', () => ({
  ApiKeysSettingsPage: () => null,
}));
vi.mock('@renderer/features/settings/pages/messaging-apps-page', () => ({
  MessagingAppsSettingsPage: () => null,
}));
vi.mock('@renderer/features/settings/pages/system-status-page', () => ({
  SystemStatusSettingsPage: () => null,
}));

import { SettingsPage } from '@renderer/features/settings/components/SettingsPage';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.adminPages = null;
  state.native = true;
  state.newLayout = false;
  state.orgAdmin = false;
  state.openPage.mockReset();
  state.start.mockReset();
  state.confirms.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SettingsPage tab="account" onTabChange={() => {}} />));
}

function link(label = 'Workspace settings'): HTMLElement | undefined {
  return [...document.querySelectorAll('button, a')].find((el) =>
    (el.textContent ?? '').includes(label)
  ) as HTMLElement | undefined;
}

it('opens the gateway a native local server serves', async () => {
  state.adminPages = 'served';
  await render();

  await act(async () => link()?.click());
  expect(state.openPage).toHaveBeenCalledWith('local', 'http://localhost:41001/workspace');
  expect(state.confirms).toHaveLength(0);
});

it('offers a restart to a native server started without the gateway', async () => {
  state.adminPages = 'restart';
  await render();

  await act(async () => link()?.click());
  expect(state.openPage).not.toHaveBeenCalled();
  expect(state.confirms).toHaveLength(1);
  expect(state.confirms[0]!.confirmLabel).toBe('Restart');
  state.confirms[0]!.onSuccess();
  expect(state.start).toHaveBeenCalledWith(LOCAL);
});

it('shows no link where a native server cannot serve the gateway', async () => {
  state.adminPages = 'unavailable';
  await render();

  expect(link()).toBeUndefined();
});

it('opens the gateway of a server run with Docker', async () => {
  state.native = false;
  await render();

  await act(async () => link()?.click());
  expect(state.openPage).toHaveBeenCalledWith('local', 'http://localhost:41001/workspace');
});

it("opens the new layout's settings where the server has it on", async () => {
  state.adminPages = 'served';
  state.newLayout = true;
  await render();

  await act(async () => link()?.click());
  expect(state.openPage).toHaveBeenCalledWith('local', 'http://localhost:41001/settings');
});

it("opens the organization's settings in whichever layout the server has on", async () => {
  state.adminPages = 'served';
  state.orgAdmin = true;
  await render();

  await act(async () => link('Organization settings')?.click());
  expect(state.openPage).toHaveBeenLastCalledWith('local', 'http://localhost:41001/organization');

  state.newLayout = true;
  await act(async () => root!.render(<SettingsPage tab="account" onTabChange={() => {}} />));
  await act(async () => link('Organization settings')?.click());
  expect(state.openPage).toHaveBeenLastCalledWith('local', 'http://localhost:41001/settings/org');
});
