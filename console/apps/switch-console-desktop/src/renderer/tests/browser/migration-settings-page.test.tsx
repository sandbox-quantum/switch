/**
 * The Settings page that shows how far the automatic move to managed agents
 * has got: one row per machine and server, and what keeps agents from moving.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MigrationOverview } from '@shared/core/agent-migration/agent-migration';

const agentMigration = vi.hoisted(() => ({
  getOverview: vi.fn<() => Promise<MigrationOverview>>(),
  runNow: vi.fn(async () => {}),
}));
const hostControllers = vi.hoisted(() => ({ enable: vi.fn(async () => {}) }));
const embeddedController = vi.hoisted(() => ({ enable: vi.fn(async () => {}) }));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { agentMigration, hostControllers, embeddedController },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => {
  const servers = [
    { id: 'pilot', name: 'Switch Pilot', url: 'https://pilot.example.com' },
    { id: 'local', name: 'Local dev', url: 'http://127.0.0.1:8000' },
  ];
  return {
    switchServersStore: {
      servers,
      serverById: (id: string) => servers.find((server) => server.id === id) ?? null,
    },
  };
});

import { MigrationSettingsPage } from '@renderer/features/agent-migration/migration-settings-page';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(overview: MigrationOverview): Promise<HTMLDivElement> {
  agentMigration.getOverview.mockResolvedValue(overview);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <MigrationSettingsPage />
      </QueryClientProvider>
    )
  );
  await vi.waitFor(() => expect(container!.querySelector('ul')).not.toBeNull());
  return container;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

it('lists each machine and server with its counter, the troubled ones first, and why', async () => {
  const el = await render({
    machines: [
      {
        machine: 'this computer',
        sshHost: null,
        serverId: 'pilot',
        total: 6,
        moved: 6,
        controller: { kind: 'ready' },
        checkedAt: '2026-10-07T17:00:00Z',
        problems: [],
      },
      {
        machine: 'dev-vm',
        sshHost: 'dev-vm',
        serverId: 'pilot',
        total: 18,
        moved: 0,
        controller: { kind: 'failed', reason: 'ssh: connect to host dev-vm: timed out' },
        checkedAt: '2026-10-07T17:00:00Z',
        problems: [],
      },
      {
        machine: 'this computer',
        sshHost: null,
        serverId: 'local',
        total: 17,
        moved: 0,
        controller: { kind: 'incompatible', reason: 'Local dev accepts protocol 1-1.' },
        checkedAt: '2026-10-07T17:00:00Z',
        problems: [],
      },
    ],
    leftAlone: 4,
    unasked: 2,
    running: false,
    lastPassAt: '2026-10-07T17:00:00Z',
  });
  const rows = [...el.querySelectorAll('li')].map((li) => li.textContent);
  expect(rows[0]).toContain('dev-vm · Switch Pilot');
  expect(rows[0]).toContain('0/18');
  expect(rows[0]).toContain('ssh: connect to host dev-vm: timed out');
  expect(rows[1]).toContain('This computer · Local dev');
  expect(rows[1]).toContain('Server too old');
  expect(rows[2]).toContain('This computer · Switch Pilot');
  expect(rows[2]).toContain('6/6');
  expect(el.textContent).toContain('4 agents stay in Console');
  expect(el.textContent).toContain('Switch could not be asked about 2 agents');
});

it('runs a check when asked', async () => {
  const el = await render({
    machines: [
      {
        machine: 'this computer',
        sshHost: null,
        serverId: 'pilot',
        total: 1,
        moved: 1,
        controller: { kind: 'ready' },
        checkedAt: null,
        problems: [],
      },
    ],
    leftAlone: 0,
    unasked: 0,
    running: false,
    lastPassAt: null,
  });
  const button = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Check now')
  )!;
  await act(async () => button.click());
  expect(agentMigration.runNow).toHaveBeenCalled();
});

it('makes a computer a machine only once the person confirms, then moves its agents', async () => {
  agentMigration.runNow.mockClear();
  const el = await render({
    machines: [
      {
        machine: 'dev-vm',
        sshHost: 'dev-vm',
        serverId: 'pilot',
        total: 3,
        moved: 0,
        controller: { kind: 'needs-consent', workspaceId: 'ws-1' },
        checkedAt: '2026-10-07T17:00:00Z',
        problems: [],
      },
    ],
    leftAlone: 0,
    unasked: 0,
    running: false,
    lastPassAt: '2026-10-07T17:00:00Z',
  });
  const buttonNamed = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(el.textContent).toContain('Waiting for you');
  await act(async () => buttonNamed('Make dev-vm a machine')!.click());
  expect(hostControllers.enable).not.toHaveBeenCalled();
  expect(el.textContent).toContain('Make dev-vm a machine?');
  expect(el.textContent).toContain('Switch Pilot (pilot.example.com) can then start');

  await act(async () => buttonNamed('Turn on')!.click());
  await vi.waitFor(() => expect(agentMigration.runNow).toHaveBeenCalled());
  expect(hostControllers.enable).toHaveBeenCalledWith({
    sshHost: 'dev-vm',
    serverId: 'pilot',
    workspaceId: 'ws-1',
  });
  expect(embeddedController.enable).not.toHaveBeenCalled();
});
