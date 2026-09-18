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
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  homedir: mocks.home,
}));
vi.mock('@switch-console/agent-providers', () => ({
  ensureSharedProcess: mocks.ensure,
  runSharedWatcher: mocks.runWatcher,
  superviseSharedHost: mocks.supervise,
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
  // Stand in for the launch path, which prepares the root then hands it over.
  mocks.ensure.mockImplementation(
    async (input: { root: string; supervision: { start: Function } }) =>
      input.supervision.start({ root: input.root, configPath: 'config.json', watcher: true })
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
  await startLocalWatcher(config);
  const root = localWatcherRoot('switch-agent-1');
  await expect
    .poll(() => readLocalHostFailure(root))
    .toEqual({ message: 'Shared SDK watcher delivery gap: sequence reset.' });
});

it('records nothing while the watcher is running', async () => {
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  await startLocalWatcher(config);
  expect(await readLocalHostFailure(localWatcherRoot('switch-agent-1'))).toBeNull();
});

it('drops a supervisor record left behind by a process that is gone', async () => {
  const root = join(home, '.local', 'state', 'switch', 'sdk-watchers');
  const keyed = localWatcherRoot('switch-agent-1');
  await mkdir(join(keyed, 'supervisor'), { recursive: true });
  await writeFile(join(keyed, 'supervisor', 'owner.json'), JSON.stringify({ pid: 999999 }));
  mocks.runWatcher.mockReturnValue(new Promise(() => {}));
  await startLocalWatcher(config);
  await expect(readFile(join(keyed, 'supervisor', 'owner.json'), 'utf8')).rejects.toThrow('ENOENT');
  expect(root).toBeTruthy();
});
