import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  bundleIdentity,
  recordWatcherHealth,
  WATCHER_HEALTH_FILE,
  watcherHealthFileSchema,
} from './watcher-health-file';
import { WatcherControl } from './watcher-tools';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function written(root: string) {
  return JSON.parse(await readFile(join(root, WATCHER_HEALTH_FILE), 'utf8'));
}

it('keeps the watcher’s own account of its connection on the host, as it changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watcher-health-'));
  roots.push(root);
  const control = new WatcherControl();
  const stop = recordWatcherHealth(root, control, 'bundle-sha');

  await vi.waitFor(async () =>
    expect(await written(root)).toMatchObject({ state: 'not-running', pid: process.pid })
  );

  control.report({ state: 'connecting' });
  control.report({ state: 'connected', placements: { session: 'room' } });
  await vi.waitFor(async () =>
    expect(await written(root)).toMatchObject({
      state: 'connected',
      detail: null,
      placements: { session: 'room' },
      pid: process.pid,
      bundle: 'bundle-sha',
    })
  );
  // Renamed into place, so nothing half-written is ever left beside it.
  expect(await readdir(root)).toEqual([WATCHER_HEALTH_FILE]);

  stop();
  control.report({ state: 'disconnected', detail: 'gone' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await written(root)).state).toBe('connected');
});

it('names the bundle a process started from by its content, and reads a file that names none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watcher-health-'));
  roots.push(root);
  const bundle = join(root, 'shared-host.mjs');
  await writeFile(bundle, 'console.log(1);');
  expect(await bundleIdentity(bundle)).toBe(
    createHash('sha256').update('console.log(1);').digest('hex')
  );

  const control = new WatcherControl();
  const stop = recordWatcherHealth(root, control, null);
  await vi.waitFor(async () => expect(await written(root)).toMatchObject({ pid: process.pid }));
  stop();
  const parsed = watcherHealthFileSchema.parse(await written(root));
  expect(parsed.bundle).toBeUndefined();
  expect(parsed.busy).toBeUndefined();
});
