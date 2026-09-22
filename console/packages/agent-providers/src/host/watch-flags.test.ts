import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { awaitWatchChange, readWatchFlags, type WatchFlags } from './watch-flags';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function watcherRoot(flags: WatchFlags) {
  const root = await mkdtemp(join(tmpdir(), 'watch-flags-'));
  roots.push(root);
  await write(root, flags);
  return root;
}

/** The rename both Console and the SSH inline script use to replace the file. */
async function write(root: string, flags: WatchFlags) {
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
  const waiting = awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal);
  let done = false;
  void waiting.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(done).toBe(false);
  await write(root, { enabled: false, spawn: false });
  await expect(waiting).resolves.toEqual({ enabled: false, spawn: false });
});

it('returns when spawning changes under a controller that stays connected', async () => {
  // The controller declares this when it opens its connection, so a change has
  // to reach it while it runs or turning automatic sessions off does nothing
  // until something restarts it.
  const root = await watcherRoot({ enabled: true, spawn: true });
  const waiting = awaitWatchChange(
    root,
    { enabled: true, spawn: true },
    new AbortController().signal
  );
  await write(root, { enabled: true, spawn: false });
  await expect(waiting).resolves.toEqual({ enabled: true, spawn: false });
});

it('does not wait for a change that already happened before it started watching', async () => {
  const root = await watcherRoot({ enabled: false, spawn: false });
  await expect(
    awaitWatchChange(root, { enabled: true, spawn: true }, new AbortController().signal)
  ).resolves.toEqual({ enabled: false, spawn: false });
});

it('keeps waiting while the flags still say what the controller is already doing', async () => {
  const root = await watcherRoot({ enabled: true, spawn: false });
  const stop = new AbortController();
  const waiting = awaitWatchChange(root, { enabled: true, spawn: false }, stop.signal);
  let done = false;
  void waiting.then(() => {
    done = true;
  });
  // Rewritten with the same contents, which is what a reconcile that changed
  // nothing does — and must not be read as a change.
  await write(root, { enabled: true, spawn: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(done).toBe(false);
  stop.abort();
  await waiting;
});

it('returns when the watcher is aborted rather than treating it as a failure', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const stop = new AbortController();
  const waiting = awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal);
  stop.abort();
  await expect(waiting).resolves.toBeNull();
  await expect(
    awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal)
  ).resolves.toBeNull();
});

it('rejects rather than standing down when the file cannot be read', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const stop = new AbortController();
  const waiting = awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal);
  await writeFile(join(root, 'watch.json'), 'not json');
  await expect(waiting).rejects.toThrow();
});
