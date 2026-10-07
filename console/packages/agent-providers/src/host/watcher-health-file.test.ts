import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionLinks } from './session-channel';
import { recordWatcherHealth, WATCHER_HEALTH_FILE } from './watcher-health-file';
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
  const stop = recordWatcherHealth(root, control, null);

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
    })
  );
  // Renamed into place, so nothing half-written is ever left beside it.
  expect(await readdir(root)).toEqual([WATCHER_HEALTH_FILE]);

  stop();
  control.report({ state: 'disconnected', detail: 'gone' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await written(root)).state).toBe('connected');
});

it('records whether the watcher’s sessions have work in hand, and when one last had', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watcher-health-'));
  roots.push(root);
  const links = new SessionLinks();
  const stop = recordWatcherHealth(root, new WatcherControl(), links);

  await vi.waitFor(async () =>
    expect(await written(root)).toMatchObject({ busy: false, lastActivityAt: null })
  );

  const child = new EventEmitter();
  links.attach(join(root, 'session'), child as unknown as ChildProcess);
  child.emit('message', {
    kind: 'busy',
    busy: true,
    reasons: [{ kind: 'turn_running', count: 1 }],
  });
  await vi.waitFor(async () => expect((await written(root)).busy).toBe(true));
  const during = (await written(root)).lastActivityAt;
  expect(typeof during).toBe('string');

  child.emit('message', { kind: 'busy', busy: false, reasons: [] });
  await vi.waitFor(async () => expect((await written(root)).busy).toBe(false));
  expect(Date.parse((await written(root)).lastActivityAt)).toBeGreaterThanOrEqual(
    Date.parse(during)
  );
  stop();
});
