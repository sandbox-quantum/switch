import type * as NodeFs from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { awaitWatchChange, readWatchFlags, type WatchFlags } from './watch-flags';

const platform = vi.hoisted(() => ({ canWatch: true, watchers: [] as FSWatcher[] }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  return {
    ...real,
    watch: (...args: Parameters<typeof real.watch>) => {
      if (!platform.canWatch)
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      const watcher = real.watch(...args);
      platform.watchers.push(watcher);
      return watcher;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  platform.canWatch = true;
  platform.watchers.length = 0;
  vi.restoreAllMocks();
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

it('reads the flags on a timer where the platform cannot watch for them', async () => {
  // A host at its descriptor or watch limit would otherwise take the agent's
  // only inbound connection down over a setting file.
  const root = await watcherRoot({ enabled: true, spawn: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  platform.canWatch = false;
  const stop = new AbortController();
  try {
    const waiting = awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal);
    await write(root, { enabled: true, spawn: false });
    await expect(waiting).resolves.toEqual({ enabled: true, spawn: false });
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    stop.abort();
  }
});

it('reads the flags on a timer after the watch it had dies', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stop = new AbortController();
  try {
    const waiting = awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal);
    platform.watchers.at(-1)?.emit('error', new Error('EMFILE: too many open files'));
    await write(root, { enabled: true, spawn: false });
    await expect(waiting).resolves.toEqual({ enabled: true, spawn: false });
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    stop.abort();
  }
});

it('rejects rather than standing down when the file cannot be read', async () => {
  const root = await watcherRoot({ enabled: true, spawn: true });
  const stop = new AbortController();
  // The assertion is attached before the file is broken: the rejection can
  // land during the write, and a promise nothing is waiting on yet is an
  // unhandled rejection rather than a result.
  const rejected = expect(
    awaitWatchChange(root, { enabled: true, spawn: true }, stop.signal)
  ).rejects.toThrow();
  await writeFile(join(root, 'watch.json'), 'not json');
  await rejected;
});
