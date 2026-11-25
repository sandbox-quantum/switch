/**
 * Settings' "Workspace settings" link opens the web gateway, including the one
 * a Switch this Console runs without Docker serves. A server an older Console
 * started without the gateway's pages is offered the restart that turns them
 * on; one that cannot serve them shows no link. Both links open the settings
 * of whichever layout the server's gateway has on, for the workspace Console
 * is in.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  newLayout: false as boolean | 'unreadable' | 'unanswered',
  warn: vi.fn(),
  orgAdmin: false,
  openPage: vi.fn(),
  start: vi.fn(),
  confirms: [] as { title: string; confirmLabel?: string; onSuccess: () => void }[],
  workspaceAdmin: false,
  decisionRouting: false,
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
  useFeatureFlags: () => ({ service_connections: false, decision_routing: state.decisionRouting }),
}));
vi.mock('@renderer/features/switch-servers/workspace-admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/switch-servers/workspace-admin')>()),
  administersWorkspaceInScope: () => state.workspaceAdmin,
}));
// Preferences, where a page the server does not offer falls back to, needs the
// app's providers; only that it is the page shown matters here.
vi.mock('@renderer/features/settings/components/ThemeCard', () => ({
  default: () => 'Theme card',
}));
vi.mock('@renderer/features/settings/pages/admin-pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/settings/pages/admin-pages')>()),
  // Stands in for the page, which asks the server for its decision routing.
  DecisionRoutingSettingsPage: () => 'Decision routing page',
}));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: state.warn } }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    featureFlags: {
      current: async () => {
        if (state.newLayout === 'unreadable') throw new Error('No handler registered');
        if (state.newLayout === 'unanswered') {
          return {
            success: true,
            data: { flags: { gateway_v2: false }, fetchedAt: null, error: 'fetch failed' },
          };
        }
        return {
          success: true,
          data: { flags: { gateway_v2: state.newLayout }, fetchedAt: 1, error: null },
        };
      },
    },
  },
  events: { on: () => () => {}, emit: () => {} },
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

import {
  SettingsPage,
  type SettingsPageTab,
} from '@renderer/features/settings/components/SettingsPage';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.adminPages = null;
  state.native = true;
  state.newLayout = false;
  state.warn.mockReset();
  state.orgAdmin = false;
  state.openPage.mockReset();
  state.start.mockReset();
  state.confirms.length = 0;
  state.workspaceAdmin = false;
  state.decisionRouting = false;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(tab: SettingsPageTab = 'account') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <SettingsPage tab={tab} onTabChange={() => {}} />
      </QueryClientProvider>
    )
  );
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
  expect(state.openPage).toHaveBeenCalledWith(
    'local',
    'http://localhost:41001/workspace?workspace=t'
  );
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
  expect(state.openPage).toHaveBeenCalledWith(
    'local',
    'http://localhost:41001/workspace?workspace=t'
  );
});

it("opens the new layout's settings where the server has it on", async () => {
  state.adminPages = 'served';
  state.newLayout = true;
  await render();

  await act(async () => link()?.click());
  expect(state.openPage).toHaveBeenCalledWith(
    'local',
    'http://localhost:41001/settings?workspace=t'
  );
});

it("opens the organization's settings in whichever layout the server has on", async () => {
  state.adminPages = 'served';
  state.orgAdmin = true;
  await render();

  await act(async () => link('Organization settings')?.click());
  expect(state.openPage).toHaveBeenLastCalledWith(
    'local',
    'http://localhost:41001/organization?workspace=t'
  );

  state.newLayout = true;
  await act(async () => link('Organization settings')?.click());
  expect(state.openPage).toHaveBeenLastCalledWith(
    'local',
    'http://localhost:41001/settings/org?workspace=t'
  );
});

it("opens today's settings where the server's flags cannot be read, and logs it", async () => {
  state.adminPages = 'served';
  for (const unread of ['unreadable', 'unanswered'] as const) {
    state.newLayout = unread;
    state.openPage.mockReset();
    state.warn.mockReset();
    await render();

    await act(async () => link()?.click());
    expect(state.openPage).toHaveBeenCalledWith(
      'local',
      'http://localhost:41001/workspace?workspace=t'
    );
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(state.warn.mock.calls[0]![1]).toMatchObject({
      serverId: 'local',
      cause: unread === 'unreadable' ? expect.any(Error) : 'fetch failed',
    });
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  }
});

it('logs nothing when the flags are read', async () => {
  state.adminPages = 'served';
  await render();

  await act(async () => link()?.click());
  expect(state.openPage).toHaveBeenCalled();
  expect(state.warn).not.toHaveBeenCalled();
});

it('offers no Message routing on a server without auto-route, even asked for it', async () => {
  state.workspaceAdmin = true;
  state.decisionRouting = false;
  await render('decision-routing');

  expect(link('Message routing')).toBeUndefined();
  expect(document.body.textContent).not.toContain('Decision routing page');
  expect(document.body.textContent).toContain('Theme card');
});

it('offers Message routing to a workspace admin where the server has auto-route', async () => {
  state.workspaceAdmin = true;
  state.decisionRouting = true;
  await render('decision-routing');

  expect(link('Message routing')).toBeDefined();
  expect(document.body.textContent).toContain('Decision routing page');
});
