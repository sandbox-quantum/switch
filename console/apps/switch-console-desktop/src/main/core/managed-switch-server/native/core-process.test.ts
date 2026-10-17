import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { waitForCoreHealth } from './core-process';
import { nativeLayout } from './native-paths';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

it('stops waiting as soon as switch-core has exited', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'switch-exited-'));
  try {
    const layout = nativeLayout(root);
    await mkdir(layout.run, { recursive: true });
    // A pid no process has: the core "exited" right after it was started.
    await writeFile(
      path.join(layout.run, 'switch-core.json'),
      JSON.stringify({
        pid: 2 ** 22 + 12345,
        version: '0.30.0',
        startedAt: new Date().toISOString(),
      })
    );
    const started = Date.now();
    const healthy = await waitForCoreHealth(
      layout,
      'http://127.0.0.1:1',
      new AbortController().signal
    );
    expect(healthy).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
