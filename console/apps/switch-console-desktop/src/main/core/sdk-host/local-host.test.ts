import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  runWatcher: vi.fn(),
  supervise: vi.fn(),
  bundle: vi.fn(() => '/bundle/shared-host.mjs'),
  home: vi.fn(),
  clearTakenOver: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  homedir: mocks.home,
}));
vi.mock('@switch-console/agent-providers', () => ({
  ensureSharedProcess: mocks.ensure,
  runSharedWatcher: mocks.runWatcher,
  superviseSharedHost: mocks.supervise,
  clearTakenOver: mocks.clearTakenOver,
  WATCH_FLAGS_FILE: 'watch.json',
  watchFlagsSchema: { parse: (value: unknown) => value },
  sharedConfigSchema: { parse: (value: unknown) => value },
}));
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: mocks.bundle,
}));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));

const { startLocalWatcher, localWatcherRoot, readLocalHostFailure } = await import('./local-host');

const roots: string[] = [];
let home: string;

beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), 'local-host-'));
  roots.push(home);
  mocks.home.mockReturnValue(home);
  // Stand in for the launch path, which writes the configuration to the root
  // and then hands the root and that file over to the supervisor.
  mocks.ensure.mockImplementation(
    async (input: { root: string; config: unknown; supervision: { start: Function } }) => {
      const configPath = join(input.root, 'config.json');
      await mkdir(input.root, { recursive: true });
      if (!existsSync(configPath)) await writeFile(configPath, JSON.stringify(input.config));
      return input.supervision.start({ root: input.root, configPath, watcher: true });
    }
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

const config = {
  session: { sessionId: 'watcher', agentId: 'switch-agent-1' },
} as never;

it('records why the watcher stopped so the agent panel can show it', async () => {
  mocks.runWatcher.mockRejectedValue(new Error('Shared SDK watcher delivery gap: sequence reset.'));
  await startLocalWatcher(config, { intent: 'explicit', spawning: true });
  const root = localWatcherRoot('switch-agent-1');
  await expect
    .poll(() => readLocalHostFailure(root))
    .toEqual({ message: 'Shared SDK watcher delivery gap: sequence reset.' });
});

it('records nothing while the watcher is running', async () => {
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  await startLocalWatcher(config, { intent: 'explicit', spawning: true });
  expect(await readLocalHostFailure(localWatcherRoot('switch-agent-1'))).toBeNull();
});

it('drops a supervisor record left behind by a process that is gone', async () => {
  const root = join(home, '.local', 'state', 'switch', 'sdk-watchers');
  const keyed = localWatcherRoot('switch-agent-1');
  await mkdir(join(keyed, 'supervisor'), { recursive: true });
  await writeFile(join(keyed, 'supervisor', 'owner.json'), JSON.stringify({ pid: 999999 }));
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  await startLocalWatcher(config, { intent: 'explicit', spawning: true });
  await expect(readFile(join(keyed, 'supervisor', 'owner.json'), 'utf8')).rejects.toThrow('ENOENT');
  expect(root).toBeTruthy();
});

it.each([
  // Boot and reconciles bring the watcher back to a state it was already in;
  // neither is anyone asking to reclaim a connection something else now holds.
  ['restore', 0],
  ['explicit', 1],
] as const)('%s clears the stood-down marker %i times', async (intent, cleared) => {
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  await startLocalWatcher(config, { intent, spawning: true });
  expect(mocks.clearTakenOver).toHaveBeenCalledTimes(cleared);
});

it.each([true, false])('writes whether the watcher may spawn (%s)', async (spawning) => {
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  await startLocalWatcher(config, { intent: 'explicit', spawning });
  const flags = join(localWatcherRoot('switch-agent-1'), 'watch.json');
  expect(JSON.parse(await readFile(flags, 'utf8'))).toEqual({ enabled: true, spawn: spawning });
});

it('runs the watcher on the configuration the root holds, not the one asked for', async () => {
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  const root = localWatcherRoot('switch-agent-1');
  await mkdir(root, { recursive: true });
  const saved = { session: { sessionId: 'watcher', agentId: 'switch-agent-1' }, kept: true };
  await writeFile(join(root, 'config.json'), JSON.stringify(saved));
  await startLocalWatcher(config, { intent: 'explicit', spawning: true });
  // The same file a deployed watcher reads, so both transports run one agent's
  // controller on the same settings.
  expect(mocks.runWatcher.mock.calls[0][1]).toEqual(saved);
});

it('appends start and failure lines to the log the panel tails', async () => {
  mocks.runWatcher.mockRejectedValue(new Error('Shared SDK watcher delivery gap: sequence reset.'));
  await startLocalWatcher(config, { intent: 'explicit', spawning: true });
  const log = join(localWatcherRoot('switch-agent-1'), 'supervisor.log');
  await expect
    .poll(() => readFile(log, 'utf8'))
    .toContain('Room watcher stopped: Shared SDK watcher delivery gap: sequence reset.');
  expect(await readFile(log, 'utf8')).toContain('Room watcher started inside Console.');
});
