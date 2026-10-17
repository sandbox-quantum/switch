import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { coreFailureLine, failureLine, startCore, waitForCoreHealth } from './core-process';
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

it('picks the line that says why switch-core stopped', () => {
  const log = [
    '2026-10-17T10:24:32 INFO  [uvicorn.error] Started server process [1]',
    'Traceback (most recent call last):',
    '  File "main.py", line 1, in <module>',
    'sqlalchemy.exc.ProgrammingError: <class \'asyncpg.exceptions.PostgresSyntaxError\'>: syntax error at or near "("',
    '[SQL: ALTER TABLE agents ADD CONSTRAINT fk_agents_parent_agent]',
    '(Background on this error at: https://sqlalche.me/e/20/f405)',
  ].join('\n');
  expect(failureLine(log)).toMatch(/^sqlalchemy\.exc\.ProgrammingError: .*syntax error/);
  expect(failureLine('just one line\n')).toBe('just one line');
  expect(failureLine('')).toBeNull();
});

it.skipIf(process.platform === 'win32')(
  'reports why a switch-core that crashed at boot stopped',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'switch-crash-'));
    try {
      const layout = nativeLayout(root);
      // Stands in for the environment's Python: dies at once with a traceback.
      const python = path.join(root, 'python');
      await writeFile(
        python,
        [
          '#!/bin/sh',
          'echo "Traceback (most recent call last):"',
          'echo "  File \\"main.py\\", line 2"',
          'echo "SyntaxError: from __future__ imports must occur at the beginning of the file" >&2',
          'exit 1',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      await startCore(
        layout,
        { version: '0.30.0', sourceRoot: root, projectDir: root, python },
        {}
      );
      const healthy = await waitForCoreHealth(
        layout,
        'http://127.0.0.1:1',
        new AbortController().signal
      );
      expect(healthy).toBe(false);
      expect(await coreFailureLine(layout)).toBe(
        'SyntaxError: from __future__ imports must occur at the beginning of the file'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
