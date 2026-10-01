/**
 * Deciding which agents a startup sweep can leave alone.
 *
 * The value is skipping work; the risk is skipping an agent that needed it,
 * because nothing notices an agent that quietly never comes up. So the
 * property under test is mostly the failure behaviour: anything unknown,
 * broken or unreachable must produce an empty set, meaning "bring everyone
 * up" — the behaviour we have today.
 */

import { expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  location: vi.fn(),
  connect: vi.fn(),
  watchers: vi.fn(),
  stopped: vi.fn(async () => [] as string[]),
  bundlePath: vi.fn(() => '/local/shared-host.mjs'),
  readFile: vi.fn(async () => Buffer.from('bundle-contents')),
  debug: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: mocks.bundlePath,
}));
vi.mock('@main/core/agents/agent-location', () => ({ getAgentLocation: mocks.location }));
vi.mock('@main/core/agents/connect-remote-agent', () => ({ connectRemoteAgent: mocks.connect }));
vi.mock('@main/core/sdk-host/host-watchers', async () => {
  const actual = await vi.importActual<object>('@main/core/sdk-host/host-watchers');
  return { ...actual, listHostWatchers: mocks.watchers };
});
vi.mock('./auto-session-store', () => ({ listStoppedControllerAgentIds: mocks.stopped }));
vi.mock('@main/lib/logger', () => ({ log: { debug: mocks.debug, error: vi.fn() } }));

const { currentWatchers } = await import('./current-watchers');
const { createHash } = await import('node:crypto');

const BUNDLE_FILE = `shared-host-${createHash('sha256').update('bundle-contents').digest('hex')}.mjs`;

const agents = [
  { id: 'a1', switchAgentId: 'switch-a1', locationId: 'loc' },
  { id: 'a2', switchAgentId: 'switch-a2', locationId: 'loc' },
] as never[];

function onHost(entries: Record<string, { running: boolean; build: string | null }>) {
  mocks.watchers.mockResolvedValue(
    new Map(
      Object.entries(entries).map(([agentId, e]) => [
        agentId,
        {
          agentId,
          root: `/r/${agentId}`,
          running: e.running,
          build: e.build,
          enabled: true,
          spawn: true,
          stoodDown: false,
        },
      ])
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.location.mockResolvedValue({ sshHost: 'vm-1' });
  mocks.connect.mockResolvedValue({ ctx: { exec: vi.fn() } });
  mocks.stopped.mockResolvedValue([]);
  mocks.bundlePath.mockReturnValue('/local/shared-host.mjs');
  mocks.readFile.mockResolvedValue(Buffer.from('bundle-contents'));
});

it('skips agents already running the bundle we would install', async () => {
  onHost({
    'switch-a1': { running: true, build: `/remote/${BUNDLE_FILE}` },
    'switch-a2': { running: true, build: `/remote/${BUNDLE_FILE}` },
  });

  expect([...(await currentWatchers(agents))].sort()).toEqual(['a1', 'a2']);
});

it('brings up the ones on an older build, leaving the current one alone', async () => {
  onHost({
    'switch-a1': { running: true, build: `/remote/${BUNDLE_FILE}` },
    'switch-a2': { running: true, build: '/remote/shared-host-older.mjs' },
  });

  expect([...(await currentWatchers(agents))]).toEqual(['a1']);
});

it('asks the host exactly once for the whole group', async () => {
  onHost({});
  await currentWatchers(agents);
  expect(mocks.watchers).toHaveBeenCalledTimes(1);
});

it('does not skip an agent whose controller is meant to be stopped', async () => {
  // Its watch flags would have to be rewritten, so the bring-up is not a
  // no-op and skipping it would silently leave the old intent in place.
  mocks.stopped.mockResolvedValue(['a2']);
  onHost({
    'switch-a1': { running: true, build: `/remote/${BUNDLE_FILE}` },
    'switch-a2': { running: true, build: `/remote/${BUNDLE_FILE}` },
  });

  expect([...(await currentWatchers(agents))]).toEqual(['a1']);
});

it('skips nothing when the host cannot be reached', async () => {
  mocks.connect.mockRejectedValue(new Error('host unreachable'));

  expect(await currentWatchers(agents)).toEqual(new Set());
});

it('skips nothing when the status command fails', async () => {
  mocks.watchers.mockRejectedValue(new Error('node: command not found'));

  expect(await currentWatchers(agents)).toEqual(new Set());
});

it('skips nothing for local agents', async () => {
  // No SSH connection to spare, so the check would cost more than it saves.
  mocks.location.mockResolvedValue({ sshHost: null });

  expect(await currentWatchers(agents)).toEqual(new Set());
  expect(mocks.watchers).not.toHaveBeenCalled();
});

it('handles an empty group without touching the host', async () => {
  expect(await currentWatchers([])).toEqual(new Set());
  expect(mocks.connect).not.toHaveBeenCalled();
});
