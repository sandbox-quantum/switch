import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  isStateRootName,
  MAKE_LAUNCH_DIR,
  RESOLVE_STATE_ROOT,
  STALE_LAUNCH_MS,
} from './state-roots';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function home() {
  const path = await mkdtemp(join(tmpdir(), 'state-roots-'));
  homes.push(path);
  return path;
}

async function saved(root: string, config: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), config);
}

const agentConfig = (agentId: string) => JSON.stringify({ session: { agentId } });

async function run(home: string, script: string, args: string[]) {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, ...args], {
    env: { ...process.env, HOME: home },
  });
  return stdout.trim();
}

async function age(path: string, ms: number) {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}

it('takes neither staging prefix for a state root', () => {
  expect(isStateRootName('a'.repeat(64))).toBe(true);
  expect(isStateRootName('.launch-qQ92Pc')).toBe(false);
  expect(isStateRootName('launch-qQ92Pc')).toBe(false);
});

it('resolves an agent’s watcher root past launches that were abandoned beside it', async () => {
  const dir = await home();
  const watchers = join(dir, '.local/state/switch/sdk-watchers');
  const root = join(watchers, 'b'.repeat(64));
  await saved(root, agentConfig('agent'));
  // A complete copy of the agent's configuration used to read as a second,
  // competing watcher; an empty one used to abort the listing outright.
  await saved(join(watchers, '.launch-copy'), agentConfig('agent'));
  await saved(join(watchers, '.launch-empty'), '');
  await saved(join(watchers, 'launch-legacy'), '{"session":');

  expect(await run(dir, RESOLVE_STATE_ROOT, ['c'.repeat(64), 'sdk-watchers', 'agent'])).toBe(root);
});

const keyedName = (identity: string) => createHash('sha256').update(identity).digest('hex');

it('reads only the agent’s own root while it holds a configuration', async () => {
  const dir = await home();
  const watchers = join(dir, '.local/state/switch/sdk-watchers');
  const root = join(watchers, keyedName('agent'));
  await saved(root, agentConfig('agent'));
  // Either neighbour would fail a listing: one is unreadable, the other claims
  // the same agent. Neither is looked at.
  await saved(join(watchers, 'a'.repeat(64)), '{"session":');
  await saved(join(watchers, 'b'.repeat(64)), agentConfig('agent'));

  expect(await run(dir, RESOLVE_STATE_ROOT, [keyedName('agent'), 'sdk-watchers', 'agent'])).toBe(
    root
  );
});

it('adopts a watcher saved under an earlier key when the agent’s own root has none', async () => {
  const dir = await home();
  const watchers = join(dir, '.local/state/switch/sdk-watchers');
  const earlier = join(watchers, 'c'.repeat(64));
  await saved(earlier, agentConfig('agent'));
  await saved(join(watchers, 'd'.repeat(64)), agentConfig('another-agent'));

  expect(await run(dir, RESOLVE_STATE_ROOT, [keyedName('agent'), 'sdk-watchers', 'agent'])).toBe(
    earlier
  );
});

it('gives an agent that never had a watcher its own root', async () => {
  const dir = await home();
  await saved(join(dir, '.local/state/switch/sdk-watchers', 'e'.repeat(64)), agentConfig('other'));

  expect(await run(dir, RESOLVE_STATE_ROOT, [keyedName('agent'), 'sdk-watchers', 'agent'])).toBe(
    join(dir, '.local/state/switch/sdk-watchers', keyedName('agent'))
  );
});

it('keys a session’s root by its id without listing anything', async () => {
  const dir = await home();
  await saved(join(dir, '.local/state/switch/sdk-sessions', 'f'.repeat(64)), '{"session":');

  expect(await run(dir, RESOLVE_STATE_ROOT, ['0'.repeat(64), 'sdk-sessions', 'agent'])).toBe(
    join(dir, '.local/state/switch/sdk-sessions', '0'.repeat(64))
  );
});

it('still refuses two genuine roots claiming one agent', async () => {
  const dir = await home();
  const watchers = join(dir, '.local/state/switch/sdk-watchers');
  await saved(join(watchers, 'd'.repeat(64)), agentConfig('agent'));
  await saved(join(watchers, 'e'.repeat(64)), agentConfig('agent'));

  await expect(
    run(dir, RESOLVE_STATE_ROOT, ['f'.repeat(64), 'sdk-watchers', 'agent'])
  ).rejects.toThrow('Competing saved watchers require explicit cleanup.');
});

it('stages a launch outside the directory its root is listed in', async () => {
  const dir = await home();
  const root = join(dir, '.local/state/switch/sdk-watchers', 'a'.repeat(64));

  const staged = await run(dir, MAKE_LAUNCH_DIR, [root, String(STALE_LAUNCH_MS)]);

  expect(dirname(staged)).toBe(join(dir, '.local/state/switch/sdk-launch'));
  expect((await stat(staged)).mode & 0o777).toBe(0o700);
  expect((await stat(dirname(staged))).mode & 0o777).toBe(0o700);
});

it('removes what abandoned launches left, and nothing still in use', async () => {
  const dir = await home();
  const state = join(dir, '.local/state/switch');
  const watchers = join(state, 'sdk-watchers');
  const root = join(watchers, 'a'.repeat(64));
  await saved(root, agentConfig('agent'));
  await age(root, 2 * STALE_LAUNCH_MS);
  const staleStaged = join(state, 'sdk-launch/launch-stale');
  const freshStaged = join(state, 'sdk-launch/launch-fresh');
  const staleDotted = join(watchers, '.launch-stale');
  const staleLegacy = join(watchers, 'launch-stale');
  const freshDotted = join(watchers, '.launch-fresh');
  for (const path of [staleStaged, freshStaged, staleDotted, staleLegacy, freshDotted])
    await saved(path, agentConfig('agent'));
  for (const path of [staleStaged, staleDotted, staleLegacy]) await age(path, 2 * STALE_LAUNCH_MS);

  await run(dir, MAKE_LAUNCH_DIR, [root, String(STALE_LAUNCH_MS)]);

  for (const path of [staleStaged, staleDotted, staleLegacy]) expect(existsSync(path)).toBe(false);
  for (const path of [freshStaged, freshDotted, root]) expect(existsSync(path)).toBe(true);
});
