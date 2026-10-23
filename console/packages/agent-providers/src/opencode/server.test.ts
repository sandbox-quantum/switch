import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stopOpencodeServer } from './server';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-server-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stopOpencodeServer', () => {
  it.skipIf(process.platform === 'win32')(
    'terminates remaining processes in process group and removes configHome even if root process already exited',
    async () => {
      const configHome = join(root, 'config-home');
      await mkdir(configHome, { recursive: true });

      // Simulate a wrapper script launched with detached: true (as in startOpencodeServer)
      // The wrapper spawns a long-running process in the same process group, prints its PID, and exits.
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
          const { spawn } = require('node:child_process');
          const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore'
          });
          console.log(sub.pid);
          process.exit(0);
          `,
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );

      const [line] = await once(child.stdout!, 'data');
      const subPid = Number(String(line).trim());
      await once(child, 'exit');
      expect(child.exitCode).toBe(0);

      // Verify subPid is initially alive
      expect(() => process.kill(subPid, 0)).not.toThrow();

      try {
        await stopOpencodeServer({ process: child, configHome });

        // Verify configHome was removed
        await expect(stat(configHome)).rejects.toThrow();

        // Verify subPid was terminated by stopOpencodeServer
        let stillRunning = true;
        for (let waited = 0; waited < 5000; waited += 100) {
          try {
            process.kill(subPid, 0);
          } catch {
            stillRunning = false;
            break;
          }
          await delay(100);
        }
        expect(stillRunning).toBe(false);
      } finally {
        try {
          process.kill(subPid, 'SIGKILL');
        } catch {}
      }
    }
  );
});
