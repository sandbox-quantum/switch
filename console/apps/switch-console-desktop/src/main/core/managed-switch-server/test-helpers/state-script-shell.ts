import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * For running the state scripts in local `sh`. Where there is no `flock`
 * (macOS), a no-op stand-in goes first on the PATH: these tests run one script
 * at a time, and stack-lock.docker.test.ts tests the mutex on a real volume.
 */
export function stateScriptEnv(): NodeJS.ProcessEnv {
  try {
    execFileSync('sh', ['-c', 'command -v flock'], { stdio: 'pipe' });
    return process.env;
  } catch {
    const bin = mkdtempSync(join(tmpdir(), 'no-flock-'));
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'flock'), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  }
}
