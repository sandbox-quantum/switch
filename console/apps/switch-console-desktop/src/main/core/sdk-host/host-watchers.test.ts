/**
 * The skip check that lets a host's agents be brought up only when needed.
 *
 * Bringing one controller up is about a dozen SSH round trips whose usual
 * outcome is nothing — the watcher is already running the right build. This
 * decides that in advance, from one command per host.
 *
 * What these tests are really about is the asymmetry: wrongly deciding "needs
 * work" costs a redundant bring-up, which is what happens today anyway.
 * Wrongly deciding "current" leaves an agent off the air with nothing to
 * notice. So every uncertain case has to fall on the safe side, and that is
 * most of what is asserted here.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  listHostWatchers,
  watcherIsCurrent,
  watcherRunsBundle,
  WATCHER_STATUS_SCRIPT,
  type HostWatcherStatus,
} from './host-watchers';

const ENTRYPOINT = '/home/u/.local/state/switch/sdk-host/shared-host-abc123.mjs';
const BUNDLE_FILE = 'shared-host-abc123.mjs';
const want = { bundleFile: BUNDLE_FILE, enabled: true, spawn: true };

function status(overrides: Partial<HostWatcherStatus> = {}): HostWatcherStatus {
  return {
    agentId: 'switch-a1',
    root: '/home/u/.local/state/switch/sdk-watchers/hash',
    running: true,
    build: ENTRYPOINT,
    enabled: true,
    spawn: true,
    stoodDown: false,
    supervisorPid: 100,
    workerPid: 101,
    workerAlive: true,
    health: null,
    failure: null,
    takenOver: null,
    ...overrides,
  };
}

it('skips a watcher that is running the right build with the right flags', () => {
  expect(watcherIsCurrent(status(), want)).toBe(true);
});

it.each([
  ['the agent is not on the host at all', undefined],
  ['no supervisor is running', status({ running: false })],
  ['it runs a different build', status({ build: '/…/shared-host-old.mjs' })],
  ['its build is unknown', status({ build: null })],
  ['it has no watch flags yet', status({ enabled: null, spawn: null })],
  ['it is enabled but will not spawn', status({ spawn: false })],
  ['it is disabled', status({ enabled: false })],
  ['it stood down for another client', status({ stoodDown: true })],
])('brings up when %s', (_case, given) => {
  expect(watcherIsCurrent(given as HostWatcherStatus | undefined, want)).toBe(false);
});

it('does not skip when the flags we want differ from the ones it has', () => {
  // The bring-up writes watch.json, so "running the right build" alone is not
  // enough — skipping here would silently drop a change to what it may do.
  expect(watcherIsCurrent(status(), { ...want, spawn: false })).toBe(false);
});

it('reads every watcher on the host in one command, keyed by agent', async () => {
  const exec = vi.fn(async () => ({
    stdout: JSON.stringify([
      status({ agentId: 'switch-a1', root: '/r/1' }),
      status({
        agentId: 'switch-a2',
        root: '/r/2',
        running: false,
        build: null,
        enabled: null,
        spawn: null,
      }),
    ]),
    stderr: '',
    exitCode: 0,
  }));

  const found = await listHostWatchers({ exec } as never);

  expect(exec).toHaveBeenCalledTimes(1);
  expect([...found.keys()].sort()).toEqual(['switch-a1', 'switch-a2']);
  expect(watcherIsCurrent(found.get('switch-a1'), want)).toBe(true);
  expect(watcherIsCurrent(found.get('switch-a2'), want)).toBe(false);
});

it('treats a host with no watchers as nothing to skip', async () => {
  const exec = vi.fn(async () => ({ stdout: '[]', stderr: '', exitCode: 0 }));

  const found = await listHostWatchers({ exec } as never);

  expect(found.size).toBe(0);
  expect(watcherIsCurrent(found.get('switch-a1'), want)).toBe(false);
});

it('reports each watcher’s process, what it wrote about itself, and why it stopped', async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-watchers-'));
  try {
    const write = async (root: string, file: string, body: unknown) => {
      await mkdir(join(base, root, file.includes('/') ? file.split('/')[0]! : ''), {
        recursive: true,
      });
      await writeFile(join(base, root, file), JSON.stringify(body));
    };
    const healthFile = { state: 'connected', detail: null, since: 'x', placements: {} };
    // Alive: this test's own process stands in for the watcher.
    await write('alive', 'config.json', { session: { agentId: 'switch-alive' } });
    await write('alive', 'shared-owner.lock', { pid: process.pid });
    await write('alive', 'health.json', { ...healthFile, pid: process.pid, updatedAt: 'y' });
    // Stopped, with the reason it recorded and no process behind its lock.
    await write('dead', 'config.json', { session: { agentId: 'switch-dead' } });
    await write('dead', 'shared-owner.lock', { pid: 2 ** 22 + 12345 });
    await write('dead', 'supervisor/failure.json', { message: 'out of memory' });
    // Stood down for another client.
    await write('displaced', 'config.json', { session: { agentId: 'switch-displaced' } });
    await write('displaced', 'taken-over.json', { at: 'z', reason: 'another client' });
    // A staging directory an interrupted launch left: not a watcher.
    await write('.launch-x', 'config.json', { session: { agentId: 'switch-alive' } });

    const { stdout } = await promisify(execFile)(process.execPath, [
      '-e',
      WATCHER_STATUS_SCRIPT,
      base,
    ]);
    const found = new Map(
      (JSON.parse(stdout) as HostWatcherStatus[]).map((entry) => [entry.agentId, entry])
    );

    expect([...found.keys()].sort()).toEqual(['switch-alive', 'switch-dead', 'switch-displaced']);
    expect(found.get('switch-alive')).toMatchObject({
      workerPid: process.pid,
      workerAlive: true,
      health: { state: 'connected', pid: process.pid },
    });
    expect(found.get('switch-dead')).toMatchObject({
      workerAlive: false,
      failure: 'out of memory',
    });
    expect(found.get('switch-displaced')).toMatchObject({
      stoodDown: true,
      takenOver: { at: 'z', reason: 'another client' },
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

describe('which bundle a watcher runs', () => {
  const bundle = { identity: 'abc123', file: BUNDLE_FILE };
  const health = (extra: object) => ({
    state: 'connected',
    detail: null,
    since: '2026-11-01T00:00:00.000Z',
    placements: {},
    pid: 101,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  });

  it('takes the word of the watcher process alive now', () => {
    expect(watcherRunsBundle(status({ health: health({ bundle: 'abc123' }) }), bundle)).toBe(true);
    expect(watcherRunsBundle(status({ health: health({ bundle: 'older' }) }), bundle)).toBe(false);
  });

  it('takes a watcher whose own record names no bundle to run another build', () => {
    expect(watcherRunsBundle(status({ health: health({}) }), bundle)).toBe(false);
  });

  it.each([
    ['written nothing yet', status({ health: null })],
    ['written a record it cannot read', status({ health: { pid: 101 } })],
    ['only the file a previous process left', status({ health: health({ pid: 99 }) })],
    [
      'only the file a previous process on another build left',
      status({ health: health({ bundle: 'older', pid: 99 }) }),
    ],
  ])('has no answer for a watcher process that has %s', (_label, watcher) => {
    expect(watcherRunsBundle(watcher, bundle)).toBeNull();
  });

  it('asks the supervisor while the watcher process is down', () => {
    const down = { workerAlive: false, health: health({ bundle: 'abc123' }) };
    expect(watcherRunsBundle(status(down), bundle)).toBe(true);
    expect(watcherRunsBundle(status({ ...down, build: '/…/shared-host-old.mjs' }), bundle)).toBe(
      false
    );
    expect(watcherRunsBundle(status({ ...down, build: null }), bundle)).toBeNull();
  });

  it('has no answer when no watcher is running', () => {
    expect(watcherRunsBundle(undefined, bundle)).toBeNull();
    expect(watcherRunsBundle(status({ running: false, workerAlive: false }), bundle)).toBeNull();
  });
});
