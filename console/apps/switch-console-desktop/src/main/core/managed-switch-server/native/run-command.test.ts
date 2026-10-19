import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runLeavingProcess } from './run-command';

it.skipIf(process.platform === 'win32')(
  'returns when the command exits, even though what it started still holds its output',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'switch-leaving-'));
    const logFile = path.join(dir, 'out.log');
    try {
      const started = Date.now();
      // The background sleep inherits the command's stdout, as postgres
      // inherits pg_ctl's on Windows; a wait on that closing would take 30 s.
      await runLeavingProcess('sh', ['-c', 'echo starting; sleep 30 & exit 0'], {
        cwd: dir,
        env: process.env,
        logFile,
        timeoutMs: 10_000,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await readFile(logFile, 'utf8')).toContain('starting');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);
