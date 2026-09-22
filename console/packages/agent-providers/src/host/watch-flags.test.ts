import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { awaitWatchDisabled, readWatchFlags } from './watch-flags';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function watcherRoot(flags: { enabled: boolean; spawn: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'watch-flags-'));
  roots.push(root);
  await write(root, flags);
  return root;
}

/** The rename both Console and the SSH inline script use to replace the file. */
async function write(root: string, flags: { enabled: boolean; spawn: boolean }) {
  const temporary = join(root, 'watch.json.tmp');
  await writeFile(temporary, JSON.stringify(flags));
  await rename(temporary, join(root, 'watch.json'));
}

it('reads both flags back', async () => {
  const root = await watcherRoot({ enabled: true, spawn: false });
  expect(await readWatchFlags(root)).toEqual({ enabled: true, spawn: false });
});

it('returns as soon as the file says to stand down', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const stop = new AbortController();
  const waiting = awaitWatchDisabled(root, stop.signal);
  let done = false;
  void waiting.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(done).toBe(false);
  await write(root, { enabled: false, spawn: false });
  await expect(waiting).resolves.toBeUndefined();
});

it('does not wait for a change that already happened before it started watching', async () => {
  const root = await watcherRoot({ enabled: false, spawn: false });
  await expect(awaitWatchDisabled(root, new AbortController().signal)).resolves.toBeUndefined();
});

it('returns when the watcher is aborted rather than treating it as a failure', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const stop = new AbortController();
  const waiting = awaitWatchDisabled(root, stop.signal);
  stop.abort();
  await expect(waiting).resolves.toBeUndefined();
  await expect(awaitWatchDisabled(root, stop.signal)).resolves.toBeUndefined();
});

it('rejects rather than standing down when the file cannot be read', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const stop = new AbortController();
  const waiting = awaitWatchDisabled(root, stop.signal);
  await writeFile(join(root, 'watch.json'), 'not json');
  await expect(waiting).rejects.toThrow();
});
